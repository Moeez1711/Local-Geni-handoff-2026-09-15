import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon, PageHead } from './ui.jsx';
import ProviderIcon from './ProviderIcon.jsx';
import { smsLength } from '../../../shared/sms.js';
import '../messaging.css';
import SmsBulkWorkspace from './SmsBulkWorkspace.jsx';

const label = id => ({ twilio: 'Twilio', telnyx: 'Telnyx', vonage: 'Vonage' })[id];
export default function SmsWorkspace({ notify, onOpenIntegrations, onDirtyChange, onBusyChange }) {
  const [connections, setConnections] = useState([]), [rows, setRows] = useState([]), [simulated, setSimulated] = useState(false);
  const [provider, setProvider] = useState('twilio'), [recipient, setRecipient] = useState(''), [body, setBody] = useState(''), [consent, setConsent] = useState(false);
  const [review, setReview] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState(''), [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const locked = useRef(false);
  const [mode,setMode] = useState('single'), [bulkDirty,setBulkDirty] = useState(false), [bulkBusy,setBulkBusy] = useState(false);
  const bulkDirtyChange=useCallback(value=>{setBulkDirty(value);onDirtyChange?.(value);},[onDirtyChange]);
  const bulkBusyChange=useCallback(value=>{setBulkBusy(value);onBusyChange?.(value);},[onBusyChange]);
  function changeMode(next) { if(next===mode)return true; if((dirty||bulkDirty)&&!window.confirm('Discard this unsent SMS draft?'))return false;setRecipient('');setBody('');setConsent(false);setReview(false);setMode(next);return true; }
  function handleModeKeyDown(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'single' : event.key === 'End' ? 'bulk' : event.key === 'ArrowLeft' ? 'single' : 'bulk';
    if (changeMode(next)) requestAnimationFrame(() => document.getElementById(`sms-${next}-tab`)?.focus());
  }
  const connection = connections.find(item => item.id === provider);
  const dirty = Boolean(recipient || body);
  const length = smsLength(body);
  useEffect(() => { if(mode!=='single')return; onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, mode, onDirtyChange]);
  useEffect(() => { if(mode!=='single')return; onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, mode, onBusyChange]);
  useEffect(() => { const unload = e => { if (dirty || locked.current) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', unload); return () => window.removeEventListener('beforeunload', unload); }, [dirty]);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([api.get('/sms/connections', { signal: controller.signal }), api.get('/sms/messages', { signal: controller.signal })]).then(([c, m]) => { setConnections(c.rows); setRows(m.rows); setSimulated(c.simulated); const ready = c.rows.find(item => item.verified); if (ready) setProvider(ready.id); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, []);
  const replace = message => setRows(current => [message, ...current.filter(item => item.id !== message.id)].sort((a, b) => b.createdAt - a.createdAt));
  async function action(name, fn) {
    if (locked.current) return; locked.current = true; setBusy(name); setError('');
    try { await fn(); } catch (e) { setError(e.message); } finally { locked.current = false; setBusy(''); }
  }
  const edit = fn => value => { fn(value); setReview(false); setRequestId(crypto.randomUUID()); };
  async function send() {
    await action('send', async () => {
      const result = await api.post('/sms/messages', { provider, recipient, body, consent, confirmed: true, requestId, connectionRevision: connection?.revision });
      replace(result.message); setReview(false);
      if (['failed', 'unknown', 'undelivered', 'submitting'].includes(result.message.status)) { setError(result.message.error || 'Submission is in progress. Check history before sending again.'); return; }
      setRecipient(''); setBody(''); setConsent(false); setRequestId(crypto.randomUUID()); notify(simulated ? 'Sample SMS accepted' : 'SMS accepted by provider', 'success');
    });
  }
  return <div className="page sms-page">
    <PageHead title="SMS"><button className="btn" disabled={Boolean(busy)||bulkBusy} onClick={onOpenIntegrations}><Icon name="plug" size={15}/>Providers</button></PageHead>
    <div className="sms-workspace-tabs" role="tablist" aria-label="SMS mode"><button type="button" role="tab" id="sms-single-tab" aria-selected={mode==='single'} aria-controls="sms-single-panel" tabIndex={mode==='single' ? 0 : -1} className={mode==='single'?'on':''} disabled={Boolean(busy)||bulkBusy} onClick={()=>changeMode('single')} onKeyDown={handleModeKeyDown}><Icon name="person" size={16}/>Single SMS</button><button type="button" role="tab" id="sms-bulk-tab" aria-selected={mode==='bulk'} aria-controls="sms-bulk-panel" tabIndex={mode==='bulk' ? 0 : -1} className={mode==='bulk'?'on':''} disabled={Boolean(busy)||bulkBusy} onClick={()=>changeMode('bulk')} onKeyDown={handleModeKeyDown}><Icon name="list" size={16}/>Bulk SMS</button></div>
    {mode==='bulk' ? <div id="sms-bulk-panel" role="tabpanel" aria-labelledby="sms-bulk-tab"><SmsBulkWorkspace connections={connections} simulated={simulated} notify={notify} onDirtyChange={bulkDirtyChange} onBusyChange={bulkBusyChange}/></div> : <div id="sms-single-panel" role="tabpanel" aria-labelledby="sms-single-tab">
    {error && <p className="banner error" role="alert">{error}</p>}
    <div className="sms-layout"><section className="card sms-compose">
      <header className="card-head"><h2>New message</h2><span className={`integration-status ${connection?.verified ? 'ready' : ''}`}><i/>{simulated ? 'Sample' : connection?.verified ? 'Connected' : 'Not connected'}</span></header>
      <form className="form" onSubmit={e => { e.preventDefault(); if (review) send(); else setReview(true); }}>
        <fieldset className="form" disabled={Boolean(busy) || review}>
          <div className="sms-sender-row"><div className="sms-provider-options" role="group" aria-label="SMS provider">{['twilio', 'telnyx', 'vonage'].map(id => <button type="button" key={id} title={label(id)} aria-label={label(id)} aria-pressed={provider === id} className={provider === id ? 'on' : ''} onClick={() => { edit(setProvider)(id); }}><ProviderIcon provider={id} size={20}/></button>)}</div>
          {connection?.metadata?.fromNumber && <p className="sms-sender hint">From {connection.metadata.fromNumber}</p>}</div>
          {!connection?.verified && <p className="hint">Connect {label(provider)} in Integrations to send SMS.</p>}
          <label className="field"><span>To</span><input type="tel" required pattern="[+][0-9 ()-]{7,22}" placeholder="+1 415 555 0123" value={recipient} onChange={e => { edit(setRecipient)(e.target.value); setConsent(false); }}/></label>
          <label className="field"><span>Message</span><textarea rows={4} maxLength={1600} required value={body} onChange={e => edit(setBody)(e.target.value)} placeholder="Write a message…"/></label>
          <div className="sms-compose-meta"><span>{body.length} / 1,600</span><span>{length.segments} {length.segments === 1 ? 'segment' : 'segments'}</span></div>
          <label className="system-auto-check"><input type="checkbox" required checked={consent} onChange={e => setConsent(e.target.checked)}/><span>Recipient agreed to SMS</span></label>
        </fieldset>
        {review && <div className="sms-review"><strong>Send with {label(provider)} to {recipient}?</strong><small>From {connection?.metadata?.fromNumber}</small><p>{body}</p><small>{simulated ? 'Simulated message. No SMS is delivered.' : 'This sends a real SMS from your connected number.'}</small></div>}
        <footer className="preview-actions">{review && <button className="btn" type="button" disabled={Boolean(busy)} onClick={() => setReview(false)}>Edit</button>}<button className="btn primary" disabled={Boolean(busy) || !connection?.verified || !body.trim() || !consent}><Icon name="send" size={15}/>{busy === 'send' ? 'Sending…' : review ? simulated ? 'Simulate send' : 'Send SMS' : 'Review'}</button></footer>
      </form>
    </section><section className="card sms-history"><header className="card-head"><h2>Messages</h2><span className="muted small">{rows.length}</span></header>
      {!rows.length && <div className="sms-empty"><span className="sms-empty-symbol"><Icon name="message" size={28}/></span><h3>Start a conversation</h3><p>Compose a message, or choose Bulk SMS to prepare a recipient list.</p></div>}
      {rows.map(message => <article key={message.id}><header><strong>{message.recipient}</strong><span className={`sms-status ${message.status}`}>{message.status}</span></header><p>{message.body}</p><footer><small>{label(message.provider)} · {new Date(message.createdAt).toLocaleString()}</small><div>
        {message.provider !== 'vonage' && <button className="ci" title="Refresh delivery status" aria-label={`Refresh SMS to ${message.recipient}`} disabled={Boolean(busy)} onClick={() => action(message.id, async () => replace((await api.post(`/sms/messages/${message.id}/refresh`)).message))}><Icon name="refresh" size={14}/></button>}
        <button className="ci" title="Block future SMS" aria-label={`Block SMS to ${message.recipient}`} disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Block future SMS to ${message.recipient}?`)) action('block', async () => { await api.post('/sms/blocked', { number: message.recipient }); notify('Number blocked from SMS', 'success'); }); }}><Icon name="shield" size={14}/></button>
      </div></footer>{message.error && <p className="integration-connection-error">{message.error}</p>}</article>)}
      {rows.some(message => message.provider === 'vonage') && <p className="hint">Vonage shows provider acceptance. Check delivery in your Vonage dashboard.</p>}
    </section></div>
    </div>}
  </div>;
}
