import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from './ui.jsx';
import ProviderIcon from './ProviderIcon.jsx';
import SmsRecipientImport from './SmsRecipientImport.jsx';
import { extractPhoneColumn, normalizeImportedNumber } from '../lib/smsImport.js';
import { smsLength } from '../../../shared/sms.js';

const providers = { twilio: 'Twilio', telnyx: 'Telnyx', vonage: 'Vonage' };
export default function SmsBulkWorkspace({ connections, simulated, notify, onDirtyChange, onBusyChange }) {
  const [provider, setProvider] = useState(() => connections.find(item => item.verified)?.id || 'twilio');
  const [numbers, setNumbers] = useState(''), [body, setBody] = useState(''), [consent, setConsent] = useState(false);
  const [lists, setLists] = useState([]), [sources, setSources] = useState({}), [sourceNote, setSourceNote] = useState('');
  const [review, setReview] = useState(null), [batches, setBatches] = useState([]), [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [source, setSource] = useState('upload'), [listId, setListId] = useState(''), [importing, setImporting] = useState(false), [importDraft, setImportDraft] = useState(false);
  const importBusyChange = useCallback(value => setImporting(value), []);
  const lock = useRef(false), alive = useRef(true);
  const pending = Boolean(busy) || importing;
  const dirty = Boolean(numbers || body || importDraft), connection = connections.find(item => item.id === provider);
  const raw = numbers.split(/[\n,;]+/).map(number => number.trim()).filter(Boolean);
  const recipientCheck = useMemo(() => extractPhoneColumn(numbers.split(/[\n,;]+/).map(value => [value.trim()]).filter(row => row[0]), 0, false), [numbers]);
  const length = smsLength(body);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty,onDirtyChange]);
  useEffect(() => { onBusyChange?.(pending); return () => onBusyChange?.(false); }, [pending,onBusyChange]);
  useEffect(() => { const unload = e => { if (dirty || pending || lock.current) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload',unload); return () => window.removeEventListener('beforeunload',unload); },[dirty,pending]);
  useEffect(() => {
    alive.current = true;
    api.get('/lists').then(data => { if (alive.current) setLists(data.rows); }).catch(() => {});
    const refresh = () => api.get('/sms/batches').then(data => { if (alive.current) setBatches(data.rows); }).catch(e => { if (alive.current) setError(e.message); });
    refresh(); const timer = setInterval(refresh,4000);
    return () => { alive.current = false; clearInterval(timer); };
  },[]);
  async function action(name, fn) {
    if (lock.current) return; lock.current = true; setBusy(name); setError('');
    try { await fn(); } catch (e) { if (alive.current) setError(e.message); }
    finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  function edit(setter,value) { setter(value); setReview(null); setRequestId(crypto.randomUUID()); }
  function addNumbers(copied, name, references = {}) {
    const combined = [...new Set([...raw, ...copied].map(value => normalizeImportedNumber(value) || value))];
    if (combined.length > 1000) { setError('This would exceed 1,000 recipients. Clear the current recipients or use a smaller file.'); return false; }
    setError(''); setSources(current => ({ ...current, ...references }));
    edit(setNumbers, combined.join('\n')); setConsent(false);
    setSourceNote(`${name} · ${combined.length - new Set(raw.map(value => normalizeImportedNumber(value) || value)).size} added`);
    return true;
  }
  async function importList(id) {
    if (!id) return;
    await action('list',async () => {
      const data = await api.get(`/lists/${encodeURIComponent(id)}?limit=1000`);
      if (data.total > 1000) throw new Error('This list exceeds 1,000 businesses. Use a smaller segment.');
      if (data.list.archivedAt) throw new Error('Restore this list before using it.');
      const eligible = data.rows.filter(row => (row.phone_e164 || row.whatsapp) && row.lead_status !== 'not_interested');
      const copied = eligible.map(row => row.phone_e164 || row.whatsapp);
      if (!copied.length) throw new Error('This list has no eligible phone numbers.');
      addNumbers(copied, data.list.name, Object.fromEntries(eligible.map(row => [row.phone_e164 || row.whatsapp,row.place_id])));
    });
  }
  async function prepare(e) {
    e.preventDefault();
    await action('review',async () => {
      if (recipientCheck.invalid.length || recipientCheck.numbers.length > 1000) throw new Error('Fix invalid numbers and choose up to 1,000 recipients.');
      const recipients = recipientCheck.numbers.map(number => { return { number, ...(sources[number] ? { placeId:sources[number] } : {}) }; });
      const data = await api.post('/sms/batches/preview',{provider,body,recipients});
      setReview({ ...data, duplicates: data.duplicates + recipientCheck.duplicates });
    });
  }
  async function queue() {
    await action('queue',async () => {
      const result = await api.post('/sms/batches',{...review,requestId,confirmed:true,consent});
      setBatches(current => [result,...current.filter(item => item.id!==result.id)]);
      setNumbers('');setBody('');setConsent(false);setSources({});setSourceNote('');setReview(null);setRequestId(crypto.randomUUID());
      notify(simulated ? 'Sample SMS batch queued' : 'Bulk SMS queued','success');
    });
  }
  async function control(batch, command) {
    await action(batch.id,async () => {
      const result=await api.post(`/sms/batches/${batch.id}/${command}`);
      setBatches(current=>current.map(item=>item.id===result.id ? result:item));
      if(selected?.id===result.id)setSelected(result);
    });
  }
  return <>
    {error && <p className="banner error" role="alert">{error}</p>}
    <div className="sms-layout sms-bulk-layout"><section className="card sms-compose">
      <header className="card-head"><h2>Bulk message</h2><span className="sms-status">{simulated ? 'Sample' : 'Up to 1,000'}</span></header>
      <form className="form" onSubmit={prepare}>{!review && <fieldset className="form" disabled={pending}>
        <div className="sms-sender-row"><div className="sms-provider-options" role="group" aria-label="SMS provider">{Object.entries(providers).map(([id,name])=><button type="button" key={id} title={name} aria-label={name} className={provider===id?'on':''} aria-pressed={provider===id} onClick={()=>edit(setProvider,id)}><ProviderIcon provider={id} size={20}/></button>)}</div>
        {connection?.metadata?.fromNumber && <p className="sms-sender hint">From {connection.metadata.fromNumber}</p>}</div>
        {!connection?.verified && <p className="hint">Connect {providers[provider]} in Integrations.</p>}
        <section className="sms-recipient-source"><header><h3>Recipients</h3><span className="muted small">Up to 1,000</span></header>
          <div className="sms-source-tabs" role="group" aria-label="Recipient source">{[['upload','upload','Upload'],['paste','paste','Paste'],['list','list','Saved list']].map(([id,icon,title])=><button type="button" key={id} className={source===id?'on':''} aria-pressed={source===id} onClick={()=>setSource(id)}><Icon name={icon} size={15}/>{title}</button>)}</div>
          <div hidden={source!=='upload'}><SmsRecipientImport onAdd={addNumbers} onBusyChange={importBusyChange} onDraftChange={setImportDraft}/></div>
          {source==='list'&&<div className="sms-list-source"><label className="field"><span className="sr-only">Saved list or segment</span><select value={listId} onChange={e=>setListId(e.target.value)}><option value="">{lists.length ? 'Choose a list or segment' : 'No saved lists yet'}</option>{lists.map(list=><option key={list.id} value={list.id}>{list.name} ({list.count})</option>)}</select></label><button type="button" className="btn" disabled={!listId||pending} onClick={()=>importList(listId)}><Icon name="plus" size={15}/>Add list</button></div>}
          {source==='paste'&&<label className="field"><span className="sr-only">Recipient numbers</span><textarea aria-label="Recipient numbers" rows={4} maxLength={25000} value={numbers} onChange={e=>{edit(setNumbers,e.target.value);setConsent(false);setSourceNote('');}} placeholder={'+1 415 555 0123\n+1 415 555 0124'}/><small>Include country codes. One per line, or separated by commas.</small></label>}
          {raw.length>0&&<div className="sms-recipient-summary"><div><strong>{recipientCheck.numbers.length} ready</strong>{recipientCheck.duplicates>0&&<span>{recipientCheck.duplicates} {recipientCheck.duplicates===1?'duplicate':'duplicates'}</span>}{recipientCheck.invalid.length>0&&<span className="bad">{recipientCheck.invalid.length} invalid</span>}<button type="button" className="ci" title="Clear recipients" aria-label="Clear recipients" onClick={()=>{edit(setNumbers,'');setConsent(false);setSources({});setSourceNote('');}}><Icon name="trash" size={14}/></button></div>{sourceNote&&<small>{sourceNote}</small>}
            {source!=='paste'&&<details><summary>Edit numbers</summary><textarea aria-label="Recipient numbers" rows={4} maxLength={25000} value={numbers} onChange={e=>{edit(setNumbers,e.target.value);setConsent(false);setSourceNote('');}}/></details>}
          </div>}
          {recipientCheck.invalid.length>0&&<p className="integration-connection-error">Fix {recipientCheck.invalid.length} invalid {recipientCheck.invalid.length===1?'number':'numbers'} before review. Use + and a country code.</p>}
          {recipientCheck.numbers.length>1000&&<p className="integration-connection-error">Choose up to 1,000 unique recipients.</p>}
        </section>
        <label className="field"><span>Message</span><textarea rows={4} maxLength={1600} value={body} onChange={e=>edit(setBody,e.target.value)} placeholder="Message for every recipient…" required/></label>
        <div className="sms-compose-meta"><span>{body.length} / 1,600</span><span>{length.segments} {length.segments === 1 ? 'segment' : 'segments'} per recipient</span></div>
        <label className="system-auto-check"><input type="checkbox" required checked={consent} onChange={e=>setConsent(e.target.checked)}/><span>Every recipient agreed to SMS</span></label>
      </fieldset>}
      {!review && <footer className="preview-actions"><button className="btn primary" disabled={pending||!connection?.verified||!recipientCheck.numbers.length||recipientCheck.numbers.length>1000||recipientCheck.invalid.length>0||!body.trim()||!consent}><Icon name="check" size={15}/>{busy==='review'?'Checking…':'Review recipients'}</button></footer>}
      </form>
      {review && <section className="sms-review sms-bulk-review"><strong>{review.recipients.length} recipients · {providers[review.provider]}</strong><small>From {review.sender} · {smsLength(review.body).segments*review.recipients.length} estimated SMS segments</small><p>{review.body}</p>
        {(review.duplicates>0||review.excluded.length>0)&&<p>{review.duplicates} {review.duplicates===1?'duplicate':'duplicates'} removed · {review.excluded.length} excluded</p>}
        <details><summary>Review all recipients</summary><ul>{review.recipients.map(entry=><li key={entry.number}>{entry.number}</li>)}{review.excluded.map(entry=><li key={entry.number}>{entry.number} · {entry.reason}</li>)}</ul></details>
        <small>{simulated?'Simulated sends. No SMS is delivered.':'Sends real SMS at up to 10 messages per minute. Provider fees apply.'}</small>
        <footer className="preview-actions"><button className="btn" disabled={pending} onClick={()=>setReview(null)}>Edit</button><button className="btn primary" disabled={pending} onClick={queue}><Icon name="send" size={15}/>{busy==='queue'?'Queuing…':`Queue ${review.recipients.length} SMS`}</button></footer>
      </section>}
    </section><section className="card sms-history sms-batches"><header className="card-head"><h2>Bulk queue</h2><span className="muted small">10 / minute</span></header>
      {!batches.length&&<div className="sms-empty"><Icon name="list" size={25}/><p>No bulk messages yet</p></div>}
      {batches.map(batch=>{const processed=batch.total-(batch.counts.pending||0),accepted=['accepted','queued','sending','sent','delivered'].reduce((sum,key)=>sum+(batch.counts[key]||0),0);return <article key={batch.id}><header><strong>{batch.total} recipients · {providers[batch.provider]}</strong><span className={`sms-status ${batch.status}`}>{batch.status}</span></header><p>{batch.body}</p><div className="sms-batch-progress"><progress max={batch.total} value={processed}/><small>{processed} processed · {accepted} accepted by provider</small></div>{batch.error&&<p className="integration-connection-error">{batch.error}</p>}<footer><small>{new Date(batch.createdAt).toLocaleString()}</small><div>
        <button className="ci" title="View recipients" aria-label={`View batch ${batch.id}`} disabled={pending} onClick={()=>action('details',async()=>setSelected(await api.get(`/sms/batches/${batch.id}`)))}><Icon name="list" size={15}/></button>
        {batch.status==='running'&&<button className="btn xs" disabled={pending} onClick={()=>control(batch,'pause')}>Pause</button>}
        {batch.status==='paused'&&<button className="btn xs" disabled={pending} onClick={()=>control(batch,'resume')}>Resume unsent</button>}
        {['running','paused'].includes(batch.status)&&<button className="btn xs" disabled={pending} onClick={()=>control(batch,'cancel')}>Cancel unsent</button>}
      </div></footer></article>;})}
      {selected&&<section className="sms-batch-details"><header><strong>Recipients</strong><button className="ci" title="Close recipients" aria-label="Close recipients" onClick={()=>setSelected(null)}><Icon name="close" size={16}/></button></header><ul>{selected.recipients.map(entry=><li key={entry.number}><span>{entry.number}</span><span className="sms-status">{entry.status}</span>{entry.error&&<small>{entry.error}</small>}</li>)}</ul></section>}
      {batches.length>0&&<p className="hint">Accepted is not delivered. Pause and cancel affect unsent recipients; an in-flight message may finish.</p>}
    </section></div>
  </>;
}
