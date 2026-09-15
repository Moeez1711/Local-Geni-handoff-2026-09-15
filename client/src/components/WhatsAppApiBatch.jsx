import { useEffect, useMemo, useRef, useState } from 'react';
import { api, qs } from '../lib/api.js';
import { batchNumber, batchRestriction } from '../lib/whatsappBatch.js';
import { matchingWhatsAppConsent, WA_API_STATUSES, WA_PARAMETER_SOURCES, whatsappApiRecipients, whatsappHasQueued, whatsappReviewKey, whatsappTime } from '../lib/whatsappApi.js';
import { WhatsAppTemplateContent } from './WhatsAppWorkspace.jsx';

const noop = () => {};
const batchFrom = data => data?.batch?.id ? data.batch : data?.id ? data : null;

export default function WhatsAppApiBatch({ entries, settings, notify = noop, onChanged, onDirtyChange, onBusyChange, onSubmittedChange, onOpenSettings, onClose }) {
  const [account, setAccount] = useState(null); const [templates, setTemplates] = useState([]); const [consents, setConsents] = useState([]);
  const [templateId, setTemplateId] = useState(''); const [bindings, setBindings] = useState({}); const [included, setIncluded] = useState({});
  const [permissionId, setPermissionId] = useState(''); const [evidence, setEvidence] = useState(''); const [permissionConfirmed, setPermissionConfirmed] = useState(false);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [statusError, setStatusError] = useState('');
  const [review, setReview] = useState(null); const [checked, setChecked] = useState({}); const [opened, setOpened] = useState({});
  const [batch, setBatch] = useState(null); const [uncertain, setUncertain] = useState(false); const [clock, setClock] = useState(Date.now());
  const alive = useRef(true); const lock = useRef(false); const requestKey = useRef(null); const reviewHeading = useRef(null); const progressHeading = useRef(null);
  const ids = useMemo(() => entries.map(entry => entry.id).join(','), [entries]);
  const template = templates.find(item => item.id === templateId);
  const available = templates.filter(item => item.supported === true && item.status === 'APPROVED');
  const submitted = Boolean(batch) || uncertain;
  const dirty = !submitted && (Boolean(templateId) || Boolean(evidence) || Boolean(review));
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { onSubmittedChange?.(submitted); return () => onSubmittedChange?.(false); }, [submitted, onSubmittedChange]);
  useEffect(() => {
    alive.current = true; const controller = new AbortController();
    Promise.all([api.get('/whatsapp/settings', { signal: controller.signal }), api.get('/whatsapp/templates', { signal: controller.signal }), api.get(`/whatsapp/consents${qs({ placeIds: ids })}`, { signal: controller.signal })]).then(([sender, library, permission]) => {
      if (!alive.current || controller.signal.aborted) return;
      setAccount(sender); setTemplates(library.rows || []); setConsents(permission.rows || []);
      const seen = new Set(); const selections = {};
      for (const entry of entries) { const number = batchNumber(entry.lead); const allowed = !entry.error && number && !batchRestriction(entry) && matchingWhatsAppConsent(entry, permission.rows) && !seen.has(number); selections[entry.id] = Boolean(allowed); if (allowed) seen.add(number); }
      setIncluded(selections);
    }).catch(err => { if (!controller.signal.aborted) setError(err.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { alive.current = false; controller.abort(); };
  }, [ids]);
  useEffect(() => { if (submitted) progressHeading.current?.focus(); }, [submitted]);
  useEffect(() => { if (!review) return undefined; reviewHeading.current?.focus(); const timer = setInterval(() => setClock(Date.now()), 15000); return () => clearInterval(timer); }, [review]);
  useEffect(() => {
    if (!batch?.id || !['queued', 'sending'].includes(batch.status)) return undefined;
    let cancelled = false;
    const timer = setInterval(async () => {
      try { const next = batchFrom(await api.get(`/whatsapp/batches/${encodeURIComponent(batch.id)}`)); if (!cancelled && alive.current && next) { setBatch(next); setStatusError(''); onChanged?.(); } }
      catch (err) { if (!cancelled && alive.current) setStatusError(`Status could not be refreshed: ${err.message}`); }
    }, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [batch?.id, batch?.status, onChanged]);
  function invalidate() { setReview(null); setChecked({}); setOpened({}); setError(''); requestKey.current = null; }
  async function run(name, action) {
    if (lock.current) return; lock.current = true; setBusy(name); setError('');
    try { await action(); } catch (err) { if (alive.current) setError(err.message); } finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  function chooseTemplate(id) { setTemplateId(id); setBindings({}); invalidate(); }
  function changeBinding(key, value) { setBindings(current => ({ ...current, [key]: value })); invalidate(); }
  function selectRecipient(entry, value) {
    if (value && (!matchingWhatsAppConsent(entry, consents) || batchRestriction(entry))) return;
    const number = batchNumber(entry.lead);
    if (value && entries.some(other => other.id !== entry.id && included[other.id] && batchNumber(other.lead) === number)) { setError('Two businesses share this number. Include only one.'); return; }
    setIncluded(current => ({ ...current, [entry.id]: value })); invalidate();
  }
  async function refreshTemplates() { run('templates', async () => { const data = await api.post('/whatsapp/templates/sync'); if (alive.current) { setTemplates(data.rows || []); invalidate(); } }); }
  function showPermission(entry) {
    if (entry.id === permissionId) return;
    if (evidence && !window.confirm('Discard the unsaved permission record before choosing another business?')) return;
    setPermissionId(entry.id); setEvidence(''); setPermissionConfirmed(false);
  }
  function savePermission(entry, optedIn) {
    if (optedIn && (!permissionConfirmed || !evidence.trim())) return;
    run('permission', async () => {
      await api.put(`/whatsapp/consents/${encodeURIComponent(entry.id)}`, { number: batchNumber(entry.lead), optedIn, evidence: optedIn ? evidence : 'Permission revoked in Local Geni.', confirmed: true });
      const result = await api.get(`/whatsapp/consents${qs({ placeIds: ids })}`);
      if (alive.current) { setConsents(result.rows || []); setPermissionId(''); setEvidence(''); setPermissionConfirmed(false); if (!optedIn) setIncluded(current => ({ ...current, [entry.id]: false })); invalidate(); notify(optedIn ? 'WhatsApp permission recorded. Select this business to include it.' : 'WhatsApp permission revoked', 'success'); }
    });
  }
  function prepare() {
    if (!template || submitted) return;
    run('prepare', async () => {
      const recipients = whatsappApiRecipients(entries, template, bindings, settings, included);
      if (!recipients.length) throw new Error('Include at least one business with recorded WhatsApp permission.');
      const next = await api.post('/whatsapp/prepare', { templateId, recipients });
      if (!next.reviewToken || !next.confirmationDigest || !Array.isArray(next.messages) || next.messages.length !== recipients.length || !next.sender) throw new Error('The API review was incomplete. Nothing was sent. Prepare it again.');
      if (alive.current) { setReview(next); setChecked({}); setOpened({}); setClock(Date.now()); requestKey.current = crypto.randomUUID(); }
    });
  }
  async function reconcile() {
    if (!requestKey.current) return null;
    const result = await api.get(`/whatsapp/batches${qs({ idempotencyKey: requestKey.current })}`);
    const found = result.rows?.[0];
    if (found?.id && alive.current) { setBatch(found); setUncertain(false); setStatusError(''); onChanged?.(); }
    return found || null;
  }
  const allChecked = review?.messages?.length > 0 && review.messages.every((message, index) => checked[whatsappReviewKey(message, index)]);
  const expired = review && Number(review.expiresAt) <= clock;
  async function send() {
    if (lock.current || submitted || !review || !requestKey.current || !allChecked) return;
    if (Number(review.expiresAt) <= Date.now()) { invalidate(); setError('This review expired. Prepare a new review before sending.'); return; }
    lock.current = true; setBusy('send'); setError('');
    try {
      const result = await api.post('/whatsapp/send', { reviewToken: review.reviewToken, confirmationDigest: review.confirmationDigest, idempotencyKey: requestKey.current, confirmed: true });
      const next = batchFrom(result); if (!next?.id || !Array.isArray(next.rows)) throw new Error('The batch response could not be confirmed.');
      if (alive.current) { setBatch(next); setUncertain(false); onChanged?.(); notify('WhatsApp batch submitted. Follow its progress here.', 'success'); }
    } catch (err) {
      if (!alive.current) return;
      const ambiguous = !err.status || err.status >= 500; setUncertain(ambiguous); setError(err.message);
      try { const found = await reconcile(); if (!found && !ambiguous) { setReview(null); requestKey.current = null; } }
      catch { if (ambiguous) setStatusError('The result is uncertain. Refresh status before making another send request.'); }
    } finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  function refreshStatus() { run('status', async () => { if (batch?.id) { const next = batchFrom(await api.get(`/whatsapp/batches/${encodeURIComponent(batch.id)}`)); if (!next) throw new Error('The batch status is unavailable.'); setBatch(next); setStatusError(''); } else { const found = await reconcile(); if (!found) setStatusError('No batch record is visible yet. Do not submit it again while the result is uncertain. Refresh status again shortly.'); } }); }
  function batchAction(action) { run(action, async () => { const response = await api.post(`/whatsapp/batches/${encodeURIComponent(batch.id)}/${action}`, action === 'resume' ? { confirmed: true } : {}); const next = batchFrom(response) || batchFrom(await api.get(`/whatsapp/batches/${encodeURIComponent(batch.id)}`)); if (next) setBatch(next); onChanged?.(); }); }

  if (loading) return <p role="status" className="hint">Loading the business sender, templates and permission records...</p>;
  return <div className="whatsapp-api-batch">
    <p className="whatsapp-batch-note"><strong>Local Geni sends through your connected WhatsApp Business API.</strong> Each recipient needs recorded permission. Approved templates provide the wording. You review every personalized message before submitting the batch.</p>
    {error && <p className="whatsapp-batch-error" role="alert">{error}</p>}
    {submitted ? <>
      <section className="whatsapp-api-step"><div className="card-head"><div><h3 ref={progressHeading} tabIndex={-1}>{batch ? 'Batch progress' : 'Checking the send request'}</h3><p className="hint">{batch ? `${WA_API_STATUSES[batch.status] || batch.status}${batch.nextAttemptAt ? ` / next attempt ${whatsappTime(batch.nextAttemptAt)}` : ''}` : 'The server response was lost. No automatic resend will be attempted.'}</p></div><button className="btn xs" disabled={Boolean(busy)} onClick={refreshStatus}>{busy === 'status' ? 'Checking...' : 'Refresh status'}</button></div><p className="hint">{batch?.sender ? `From ${batch.sender.verifiedName || 'your business'} / ${batch.sender.displayPhoneNumber}. ` : ''}Accepted means Meta accepted the request, not that it was delivered or read. Active queues run while Local Geni is running. Closing this window does not cancel them.</p>{batch?.holdReason && <p className="whatsapp-batch-note">{batch.holdReason}</p>}{statusError && <p className="whatsapp-batch-error" role="alert">{statusError}</p>}<div className="whatsapp-api-result-list">{(batch?.rows || []).map(message => <article key={message.id || message.placeId}><header><div><strong>{message.businessName || message.number}</strong><p className="hint">{message.number}</p></div><span className={`whatsapp-status whatsapp-status-${message.status}`}>{WA_API_STATUSES[message.status] || message.status}</span></header>{message.error && <p className="hint bad">{message.error}</p>}{message.status === 'unknown' && <p className="hint">Do not resend this message until you have checked its outcome in Meta.</p>}<details><summary>View exact message</summary><WhatsAppTemplateContent template={message} />{!message.body && <pre className="whatsapp-template-content">{message.text}</pre>}</details></article>)}</div><div className="preview-actions mt-3">{batch?.status === 'paused' && whatsappHasQueued(batch) && <button className="btn primary" disabled={Boolean(busy)} onClick={() => batchAction('resume')}>Resume queued messages</button>}{batch && whatsappHasQueued(batch) && <button className="btn" disabled={Boolean(busy)} onClick={() => batchAction('cancel')}>Cancel unsent messages</button>}</div></section>
      <div className="whatsapp-api-actions"><p className="hint">Closing this view does not cancel a submitted batch. Open WhatsApp / Send history to check it later.</p><button className="btn primary" disabled={Boolean(busy)} onClick={onClose}>Close status view</button></div>
    </> : review ? <>
      <section className="whatsapp-api-step"><h3 ref={reviewHeading} tabIndex={-1}>Review every API message</h3><p className="hint">From {review.sender.verifiedName || 'your business'} / {review.sender.displayPhoneNumber}. Template {review.template?.name} / {review.template?.language}.</p>{review.limits && <p className="hint">Queue limits: {review.limits.dailyLimit} messages per day, {review.limits.hourlyLimit} per hour, with at least {review.limits.minIntervalSeconds} seconds between attempts.</p>}<ol className="whatsapp-api-review-list">{review.messages.map((message, index) => { const key = whatsappReviewKey(message, index); return <li key={key}><details onToggle={event => { if (event.currentTarget.open) setOpened(current => ({ ...current, [key]: true })); }}><summary><strong>{message.businessName}</strong> / {message.number}</summary><dl className="whatsapp-api-review-meta"><div><dt>Business</dt><dd>{message.businessName}</dd></div><div><dt>To</dt><dd>{message.number}</dd></div></dl><WhatsAppTemplateContent template={message} /></details><label className="whatsapp-api-review-check"><input type="checkbox" disabled={Boolean(busy) || !opened[key]} checked={Boolean(checked[key])} onChange={event => setChecked(current => ({ ...current, [key]: event.target.checked }))} /><span>I reviewed this recipient and the exact message, including its buttons.</span></label></li>; })}</ol>{expired && <p className="whatsapp-batch-error" role="alert">This review expired. Return to the template and prepare a fresh review.</p>}</section><div className="whatsapp-api-actions"><p className="hint">The next button submits {review.messages.length} approved messages. Meta account charges and limits may apply.</p><div className="preview-actions"><button className="btn" disabled={Boolean(busy)} onClick={invalidate}>Back to template</button><button className="btn primary" disabled={Boolean(busy) || !allChecked || expired} onClick={send}>{busy === 'send' ? 'Submitting...' : `Send ${review.messages.length} WhatsApp message${review.messages.length === 1 ? '' : 's'}`}</button></div></div>
    </> : <>
      {!account?.verified && <section className="whatsapp-api-step"><h3>Connect your WhatsApp Business sender</h3><p className="hint">Verify your API account and load its approved templates in WhatsApp settings. Manual chat drafts remain available without this connection.</p>{onOpenSettings && <button className="btn" onClick={onOpenSettings}>Open WhatsApp settings</button>}</section>}
      {account?.paused && <p className="whatsapp-batch-note">API sending is paused in your account settings. Unpause the account before preparing a send. Existing paused batches also need an explicit resume.</p>}
      <section className="whatsapp-api-step"><div className="card-head"><div><h3>1. Choose an approved template</h3><p className="hint">Only supported templates approved by Meta can be sent.</p></div><button className="btn xs" disabled={Boolean(busy) || !account?.verified} onClick={refreshTemplates}>{busy === 'templates' ? 'Refreshing...' : 'Refresh templates'}</button></div><div className="whatsapp-api-template-grid"><div className="form"><label className="field"><span>Template and language</span><select value={templateId} disabled={Boolean(busy) || !account?.verified} onChange={event => chooseTemplate(event.target.value)}><option value="">Choose a template</option>{available.map(item => <option key={item.id} value={item.id}>{item.name} / {item.language}</option>)}</select></label>{!available.length && <p className="hint">No supported approved templates are loaded. Refresh from Meta or create a text template in your Meta account.</p>}{template && <div className="whatsapp-api-bindings">{(template.parameters || []).map(parameter => <div className="whatsapp-api-binding" key={parameter.key}><label className="field"><span>{parameter.label || parameter.key}</span><select disabled={Boolean(busy)} value={bindings[parameter.key]?.source || ''} onChange={event => changeBinding(parameter.key, { source: event.target.value, value: '' })}><option value="">Choose a value</option>{WA_PARAMETER_SOURCES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{bindings[parameter.key]?.source === 'custom' && <label className="field whatsapp-binding-custom"><span>Exact text for {parameter.label || parameter.key}</span><input disabled={Boolean(busy)} maxLength={1024} value={bindings[parameter.key]?.value || ''} onChange={event => changeBinding(parameter.key, { source: 'custom', value: event.target.value })} /></label>}{parameter.key.startsWith('button.') && <p className="hint">Dynamic buttons use the suffix after the approved URL. The URL must match the approved template.</p>}</div>)}</div>}</div>{template && <div><WhatsAppTemplateContent template={template} /><p className="hint">Fixed wording is managed in Meta. The next step shows the filled-in messages.</p></div>}</div></section>
      <section className="whatsapp-api-step"><h3>2. Include businesses with permission</h3><p className="hint">A published WhatsApp number does not mean the business agreed to receive API messages from you.</p>{entries.map(entry => { const number = batchNumber(entry.lead); const restriction = batchRestriction(entry); const consent = matchingWhatsAppConsent(entry, consents); return <div className="whatsapp-api-recipient" key={entry.id}><div className="whatsapp-api-recipient-head"><label><input type="checkbox" checked={Boolean(included[entry.id])} disabled={Boolean(busy) || Boolean(entry.error) || !number || Boolean(restriction) || !consent} onChange={event => selectRecipient(entry, event.target.checked)} /><span><strong>{entry.lead?.name || 'Business unavailable'}</strong><small>{entry.error || restriction || (number ? `+${number}` : 'No usable international phone number')}</small><small>{consent ? `Permission recorded ${whatsappTime(consent.updatedAt)}` : 'No permission recorded for this account and number'}</small></span></label>{!entry.error && number && !restriction && account?.configured && <button className="btn xs" disabled={Boolean(busy)} onClick={() => consent ? savePermission(entry, false) : showPermission(entry)}>{consent ? 'Revoke permission' : 'Record permission'}</button>}</div>{consent?.evidence && <details><summary>View permission record</summary><p className="hint">{consent.evidence}</p></details>}{permissionId === entry.id && <div className="whatsapp-permission-form"><label className="field"><span>How and when did this business agree?</span><textarea rows={3} maxLength={1000} value={evidence} disabled={Boolean(busy)} onChange={event => setEvidence(event.target.value)} placeholder="Describe the agreement and where its record can be found." /></label><label className="whatsapp-permission-confirm"><input type="checkbox" disabled={Boolean(busy)} checked={permissionConfirmed} onChange={event => setPermissionConfirmed(event.target.checked)} /><span>This business explicitly agreed to receive WhatsApp messages from my business at this number.</span></label><div className="preview-actions"><button className="btn primary" disabled={Boolean(busy) || !permissionConfirmed || !evidence.trim()} onClick={() => savePermission(entry, true)}>{busy === 'permission' ? 'Saving...' : 'Save permission record'}</button><button className="btn" disabled={Boolean(busy)} onClick={() => { setPermissionId(''); setEvidence(''); setPermissionConfirmed(false); }}>Cancel</button></div></div>}</div>; })}</section>
      <div className="whatsapp-api-actions"><p className="hint">Preparing a review does not queue or send anything.</p><button className="btn primary" disabled={Boolean(busy) || !account?.verified || account?.paused || !template || !Object.values(included).some(Boolean)} onClick={prepare}>{busy === 'prepare' ? 'Preparing review...' : 'Review API messages'}</button></div>
    </>}
  </div>;
}
