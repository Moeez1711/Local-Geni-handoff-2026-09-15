import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { WA_API_STATUSES, whatsappHasQueued, whatsappTime } from '../lib/whatsappApi.js';
import { Icon, PageHead } from './ui.jsx';
import ProviderIcon from './ProviderIcon.jsx';
import WhatsAppDesktopInbox from './WhatsAppDesktopInbox.jsx';
import WhatsAppBusinessInbox from './WhatsAppBusinessInbox.jsx';
import '../whatsapp-workspace.css';

const noop = () => {};
const formFor = account => ({ phoneNumberId: account?.phoneNumberId || '', businessAccountId: account?.businessAccountId || '', apiVersion: account?.apiVersion || 'v26.0', dailyLimit: account?.dailyLimit ?? 25, hourlyLimit: account?.hourlyLimit ?? 5, minIntervalSeconds: account?.minIntervalSeconds ?? 120, paused: Boolean(account?.paused) });

export function WhatsAppTemplateContent({ template }) {
  if (!template) return null;
  return <><div className="whatsapp-template-content">{template.header && <strong>{template.header}</strong>}{template.body || ''}{template.footer && <footer>{template.footer}</footer>}</div>{template.buttons?.length > 0 && <div className="whatsapp-template-buttons">{template.buttons.map((button, index) => <span key={button.index ?? index}>{button.text}{button.url ? ` / ${button.url}` : button.phoneNumber ? ` / +${button.phoneNumber}` : ''}</span>)}</div>}</>;
}

export default function WhatsAppWorkspace({ notify = noop, onDirtyChange, onBusyChange, onOpenLeads, initialSection = 'inbox' }) {
  const [section, setSection] = useState(initialSection);
  const [inboxDirty, setInboxDirty] = useState(false);
  const [inboxBusy, setInboxBusy] = useState(false);
  const [account, setAccount] = useState(null); const [form, setForm] = useState(formFor()); const [saved, setSaved] = useState(formFor()); const [token, setToken] = useState('');
  const [templates, setTemplates] = useState([]); const [templateTime, setTemplateTime] = useState(null); const [messages, setMessages] = useState([]); const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [query, setQuery] = useState('');
  const alive = useRef(true); const lock = useRef(false); const formRef = useRef(null); const guard = useRef(false);
  const dirty = inboxDirty || Boolean(token) || JSON.stringify(form) !== JSON.stringify(saved); guard.current = dirty;
  const identityChanged = form.phoneNumberId !== saved.phoneNumberId || form.businessAccountId !== saved.businessAccountId || form.apiVersion !== saved.apiVersion;
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(Boolean(busy) || inboxBusy); return () => onBusyChange?.(false); }, [busy, inboxBusy, onBusyChange]);
  useEffect(() => { const unload = event => { if (guard.current || lock.current) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', unload); return () => window.removeEventListener('beforeunload', unload); }, []);
  function receive(next) { setAccount(next); const values = formFor(next); setForm(values); setSaved(values); setToken(''); }
  useEffect(() => {
    alive.current = true; const controller = new AbortController(); setLoading(true); setError('');
    api.get('/whatsapp/settings', { signal: controller.signal }).then(next => { if (alive.current && !controller.signal.aborted) receive(next); }).catch(err => { if (!controller.signal.aborted) setError(err.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { alive.current = false; controller.abort(); };
  }, []);
  async function loadSection(next) {
    if (lock.current || inboxBusy || next === section) return;
    if (dirty && !window.confirm('Discard your unsaved WhatsApp changes or reply draft?')) return;
    if (dirty) { setForm(saved); setToken(''); }
    setSection(next); setError(''); setQuery('');
    if (next === 'connection' || next === 'inbox' || next === 'business-inbox') return;
    lock.current = true; setBusy('load');
    try { if (next === 'history') await loadHistory(); else { const data = await api.get('/whatsapp/templates'); if (alive.current) { setTemplates(data.rows || []); setTemplateTime(data.updatedAt); } } }
    catch (err) { if (alive.current) setError(err.message); } finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  async function run(name, action) {
    if (lock.current) return; lock.current = true; setBusy(name); setError('');
    try { await action(); } catch (err) { if (alive.current) setError(err.message); } finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  function save(event) {
    event.preventDefault(); if (!formRef.current?.reportValidity()) return;
    run('save', async () => { const next = await api.put('/whatsapp/settings', { ...form, phoneNumberId: form.phoneNumberId.trim(), businessAccountId: form.businessAccountId.trim(), dailyLimit: Number(form.dailyLimit), hourlyLimit: Number(form.hourlyLimit), minIntervalSeconds: Number(form.minIntervalSeconds), ...(token ? { accessToken: token } : {}) }); if (alive.current) { receive(next); notify(next.verified ? 'WhatsApp settings saved' : 'Saved. Verify before sending.', 'success'); } });
  }
  function verify() { if (dirty) return; run('verify', async () => { const next = await api.post('/whatsapp/verify'); if (alive.current) { receive(next); notify('WhatsApp sender verified', 'success'); } }); }
  function disconnect() {
    if (lock.current || !window.confirm('Disconnect this WhatsApp API account and cancel its unsent queued messages? Saved message history will remain.')) return;
    run('disconnect', async () => { await api.del('/whatsapp/connection'); const next = await api.get('/whatsapp/settings'); if (alive.current) { receive(next); setTemplates([]); notify('WhatsApp API disconnected', 'success'); } });
  }
  function refreshTemplates() { run('templates', async () => { const result = await api.post('/whatsapp/templates/sync'); if (alive.current) { setTemplates(result.rows || []); setTemplateTime(result.updatedAt); notify('Templates refreshed from Meta', 'success'); } }); }
  async function loadHistory() { const [history, queues] = await Promise.all([api.get('/whatsapp/messages'), api.get('/whatsapp/batches')]); if (alive.current) { setMessages(history.rows || []); setBatches(queues.rows || []); } }
  function refreshMessages() { run('messages', loadHistory); }
  function batchAction(batch, action) { run('batch', async () => { await api.post(`/whatsapp/batches/${encodeURIComponent(batch.id)}/${action}`, action === 'resume' ? { confirmed: true } : {}); await loadHistory(); notify(action === 'resume' ? 'Queued messages resumed' : 'Unsent messages canceled', 'success'); }); }
  const hasActiveBatch = batches.some(batch => ['queued', 'sending'].includes(batch.status));
  useEffect(() => {
    if (section !== 'history' || !hasActiveBatch || busy) return undefined;
    let cancelled = false;
    const timer = setInterval(async () => {
      try { const [history, queues] = await Promise.all([api.get('/whatsapp/messages'), api.get('/whatsapp/batches')]); if (!cancelled && alive.current) { setMessages(history.rows || []); setBatches(queues.rows || []); } }
      catch (err) { if (!cancelled && alive.current) setError(`Status could not be refreshed: ${err.message}`); }
    }, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [section, hasActiveBatch, busy]);

  return <div className="page whatsapp-workspace">
    <PageHead eyebrow="Local Geni / Messaging" title={<span className="provider-label"><ProviderIcon provider="whatsapp" size={23} />WhatsApp</span>}>{onOpenLeads && ['templates', 'history'].includes(section) && <button className="btn primary" disabled={Boolean(busy)} onClick={onOpenLeads}><Icon name="leads" />Choose leads</button>}</PageHead>
    <nav className="whatsapp-workspace-nav" aria-label="WhatsApp sections">{[['inbox', 'Personal'], ['business-inbox', 'Business'], ['connection', 'Connection'], ['templates', 'Templates'], ['history', 'History']].map(([key, label]) => <button key={key} className={section === key ? 'active' : ''} aria-current={section === key ? 'page' : undefined} disabled={Boolean(busy) || inboxBusy} onClick={() => loadSection(key)}>{label}</button>)}</nav>
    {error && section !== 'inbox' && <p className="whatsapp-batch-error" role="alert">{error}</p>}
    {section === 'inbox' ? <WhatsAppDesktopInbox onOpenApi={() => loadSection('business-inbox')} /> : section === 'business-inbox' ? <WhatsAppBusinessInbox onOpenConnection={() => loadSection('connection')} onOpenTemplates={() => loadSection('templates')} onDirtyChange={setInboxDirty} onBusyChange={setInboxBusy} /> : loading ? <section className="card" role="status">Loading WhatsApp settings...</section> : section === 'connection' ? <div className="whatsapp-connection-layout">
      <form ref={formRef} onSubmit={save} className="card form"><div className="card-head"><div><h3 className="provider-label"><ProviderIcon provider="meta" size={20} />WhatsApp Business</h3></div><span className={`whatsapp-status ${account?.verified && !dirty ? 'whatsapp-status-accepted' : ''}`}>{dirty ? 'Unsaved changes' : account?.verified ? 'Verified' : account?.configured ? 'Needs verification' : 'Not connected'}</span></div><fieldset disabled={Boolean(busy)} className="form">
        <label className="field"><span>Business account ID</span><input required inputMode="numeric" pattern="[0-9]{3,32}" maxLength={32} autoComplete="off" value={form.businessAccountId} onChange={event => setForm(current => ({ ...current, businessAccountId: event.target.value }))} placeholder="From Meta WhatsApp API setup" /></label>
        <label className="field"><span>Phone number ID</span><input required inputMode="numeric" pattern="[0-9]{3,32}" maxLength={32} autoComplete="off" value={form.phoneNumberId} onChange={event => setForm(current => ({ ...current, phoneNumberId: event.target.value }))} placeholder="Meta’s ID for your sending number" /><small className="hint">Meta ID, not your phone number</small></label>
        <label className="field"><span>Access token</span><input type="password" required={!account?.hasToken || identityChanged} minLength={20} maxLength={8192} autoComplete="new-password" value={token} onChange={event => setToken(event.target.value)} placeholder={account?.hasToken && !identityChanged ? 'Saved token' : 'From Meta'} /><small className="whatsapp-token-notice">A changed account ID or API version needs a new token</small></label>
        <label className="whatsapp-permission-confirm"><input type="checkbox" checked={form.paused} onChange={event => setForm(current => ({ ...current, paused: event.target.checked }))} /><span>Pause sending</span></label><details><summary>Sending limits</summary><div className="form mt-3"><div className="field-row"><label className="field grow"><span>Daily message limit</span><input type="number" required min={1} max={1000} value={form.dailyLimit} onChange={event => setForm(current => ({ ...current, dailyLimit: event.target.value }))} /></label><label className="field grow"><span>Hourly message limit</span><input type="number" required min={1} max={100} value={form.hourlyLimit} onChange={event => setForm(current => ({ ...current, hourlyLimit: event.target.value }))} /></label></div><label className="field"><span>Wait between messages / seconds</span><input type="number" required min={1} max={3600} value={form.minIntervalSeconds} onChange={event => setForm(current => ({ ...current, minIntervalSeconds: event.target.value }))} /></label><label className="field"><span>Meta API version</span><input required pattern="v[2-9][0-9]\.0" maxLength={10} value={form.apiVersion} onChange={event => setForm(current => ({ ...current, apiVersion: event.target.value }))} /></label><p className="hint">Meta limits also apply. Resume paused batches manually.</p></div></details>
        <div className="preview-actions"><button className="btn primary" disabled={Boolean(busy) || !dirty}>{busy === 'save' ? 'Saving...' : 'Save'}</button><button type="button" className="btn" disabled={Boolean(busy) || dirty || !account?.configured} onClick={verify}>{busy === 'verify' ? 'Verifying...' : 'Verify'}</button>{account?.configured && <button type="button" className="btn ghost" disabled={Boolean(busy)} onClick={disconnect}>Disconnect</button>}</div><p className="hint">Verification sends no messages</p>
      </fieldset>{account?.displayPhoneNumber && <dl className="whatsapp-account-details"><div><dt>Business name</dt><dd>{account.verifiedName || 'Not supplied by Meta'}</dd></div><div><dt>Sending number</dt><dd>{account.displayPhoneNumber}</dd></div>{account.updatedAt && <div><dt>Last updated</dt><dd>{whatsappTime(account.updatedAt)}</dd></div>}</dl>}</form>
      <aside><details className="card integration-help"><summary>Setup guide</summary><div className="form mt-3"><p>Copy your account IDs and token from Meta.</p><p>Save, verify, then refresh your templates.</p><p>Recipients must explicitly agree to receive your WhatsApp messages.</p><a className="btn" href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started" target="_blank" rel="noreferrer"><ProviderIcon provider="meta" size={16} />Open Meta guide</a></div></details></aside>
    </div> : section === 'templates' ? <section className="form"><div className="card-head"><div>{templateTime && <p className="hint">Updated {whatsappTime(templateTime)}</p>}</div><button className="btn primary" disabled={Boolean(busy) || !account?.verified} onClick={refreshTemplates}>{busy === 'templates' ? 'Refreshing...' : 'Refresh'}</button></div>{!account?.verified && <p className="whatsapp-batch-note">Verify your connection to load templates</p>}{templates.length ? <div className="whatsapp-template-library">{templates.map(template => <article className="card whatsapp-template-card" key={template.id}><header><div><h3>{template.name}</h3><p className="hint">{template.language} / {template.category}</p></div><span className="whatsapp-status">{template.status}</span></header><WhatsAppTemplateContent template={template} />{template.supported === false && <p className="whatsapp-template-warning">{template.unsupportedReason || 'This template format is not supported for sending in Local Geni.'}</p>}</article>)}</div> : <div className="card workflow-empty"><Icon name="message" /><h3>No templates loaded</h3></div>}</section>
      : <section className="form"><div className="card-head"><div><p className="hint">Accepted does not mean delivered or read</p></div><button className="btn" disabled={Boolean(busy)} onClick={refreshMessages}>{busy === 'messages' ? 'Refreshing...' : 'Refresh'}</button></div><div className="whatsapp-message-history">{batches.map(batch => <article key={batch.id}><header><div><h3>Batch from {whatsappTime(batch.createdAt)}</h3><p className="hint">{batch.counts?.accepted || 0} accepted / {batch.counts?.queued || 0} queued / {(batch.counts?.failed || 0) + (batch.counts?.unknown || 0)} need attention</p></div><span className={`whatsapp-status whatsapp-status-${batch.status}`}>{WA_API_STATUSES[batch.status] || batch.status}</span></header>{batch.sender && <p className="hint">From {batch.sender.verifiedName || 'your business'} / {batch.sender.displayPhoneNumber}{batch.template ? ` / ${batch.template.name} (${batch.template.language})` : ''}</p>}{batch.holdReason && <p className="hint">{batch.holdReason}</p>}{batch.nextAttemptAt && whatsappHasQueued(batch) && <p className="hint">Next attempt: {whatsappTime(batch.nextAttemptAt)}. Keep Local Geni running for queued work.</p>}<details><summary>Messages</summary><div className="whatsapp-api-result-list">{(batch.rows || []).map(message => <article key={message.id}><header><strong>{message.businessName || message.number} / {message.number}</strong><span className={`whatsapp-status whatsapp-status-${message.status}`}>{WA_API_STATUSES[message.status] || message.status}</span></header>{message.error && <p className="hint bad">{message.error}</p>}<WhatsAppTemplateContent template={message} /></article>)}</div></details><div className="preview-actions mt-3">{batch.status === 'paused' && whatsappHasQueued(batch) && <button className="btn primary" disabled={Boolean(busy)} onClick={() => batchAction(batch, 'resume')}>Resume queue</button>}{whatsappHasQueued(batch) && <button className="btn" disabled={Boolean(busy)} onClick={() => batchAction(batch, 'cancel')}>Cancel queue</button>}</div></article>)}</div><h3>Individual messages</h3><label className="field"><span>Find a message</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Business, phone number or template" /></label><div className="whatsapp-message-history">{messages.filter(message => `${message.businessName || ''} ${message.number || ''} ${message.templateName || ''} ${message.text || ''}`.toLowerCase().includes(query.toLowerCase())).map(message => <article key={message.id}><header><div><h3>{message.businessName || message.number}</h3><p className="hint">{message.number} / {message.templateName || 'Template message'}</p><p className="hint">{whatsappTime(message.createdAt)}</p></div><span className={`whatsapp-status whatsapp-status-${message.status}`}>{WA_API_STATUSES[message.status] || message.status}</span></header>{message.error && <p className="hint bad">{message.error}</p>}{message.status === 'unknown' && <p className="hint">Send result unknown. Check Meta before resending. No automatic retry.</p>}<details><summary>Message</summary><WhatsAppTemplateContent template={message} />{!message.body && message.text && <pre className="whatsapp-template-content">{message.text}</pre>}</details></article>)}</div>{!messages.length && <div className="card workflow-empty"><Icon name="message" /><h3>No messages</h3></div>}</section>}
  </div>;
}
