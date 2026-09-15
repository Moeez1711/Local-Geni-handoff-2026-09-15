import { useCallback, useEffect, useRef, useState } from 'react';
import { api, qs } from '../lib/api.js';
import { EMAIL_STATUS_LABELS, emailTime } from '../lib/email.js';
import { CAMPAIGN_STATUS_LABELS, campaignPayload, campaignReviewKey, validateCampaign } from '../lib/emailWorkflows.js';
import { Icon, Kpi, PageHead } from './ui.jsx';

const noop = () => {};
const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];
const TEMPLATES = ['businessName', 'contactName', 'category', 'specificImprovement'];
const blank = (accountId) => ({ name: '', accountId: accountId || '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', sendWindow: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] }, recipients: [], steps: [{ subject: 'A homepage idea for {businessName}', text: '', delayHours: 0 }] });
const detailFor = (value) => value?.campaign ? { ...value.campaign, recipients: value.recipients || value.campaign.recipients, steps: value.steps || value.campaign.steps, messages: value.messages || value.campaign.messages } : value;
const formFor = (campaign, accountId) => campaign ? { ...blank(accountId), name: campaign.name || '', accountId: campaign.accountId || accountId || '', timezone: campaign.timezone || 'UTC', sendWindow: campaign.sendWindow || blank().sendWindow, recipients: (campaign.recipients || []).map((row) => ({ placeId: row.placeId, to: row.to, name: row.name || row.businessName || row.to })), steps: (campaign.steps || []).map((step) => ({ subject: step.subject, text: step.text, delayHours: step.delayHours })) } : blank(accountId);

export default function CampaignWorkspace({ accountId, initialDraft, onConsumedDraft, notify = noop, onDirtyChange, onBusyChange, onOpenSettings, onOpenPublishing }) {
  const [rows, setRows] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => blank(accountId));
  const [saved, setSaved] = useState(() => blank(accountId));
  const [query, setQuery] = useState('');
  const [leads, setLeads] = useState([]);
  const [leadLoading, setLeadLoading] = useState(false);
  const [leadError, setLeadError] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [review, setReview] = useState(null);
  const [checked, setChecked] = useState({});
  const [opened, setOpened] = useState({});
  const [clock, setClock] = useState(Date.now());
  const alive = useRef(true);
  const lock = useRef(false);
  const guard = useRef(false);
  const reviewHeading = useRef(null);
  const consumedDraft = useRef(null);
  const dirty = editing && JSON.stringify(form) !== JSON.stringify(saved);
  guard.current = dirty || Boolean(busy);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [campaigns, mailboxes] = await Promise.all([api.get('/email/campaigns'), api.get('/email/accounts')]);
      if (alive.current) { setRows(campaigns.rows || []); setAccounts(mailboxes.rows || []); }
    } catch (err) { if (alive.current) setError(err.message); } finally { if (alive.current) setLoading(false); }
  }, []);
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; }; }, [load]);
  useEffect(() => {
    if (!initialDraft || consumedDraft.current === initialDraft.id) return;
    consumedDraft.current = initialDraft.id;
    const base = blank(accountId);
    setForm({ ...base, name: initialDraft.name || '', recipients: initialDraft.recipients || [] });
    setSaved(base); setDetail(null); setEditing(true); setQuery(''); setError(''); clearReview();
    onConsumedDraft?.();
  }, [initialDraft, accountId, onConsumedDraft]);
  useEffect(() => { onDirtyChange?.(guard.current); }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    const beforeUnload = (event) => { if (guard.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  useEffect(() => {
    if (!review) return undefined;
    reviewHeading.current?.focus();
    const timer = setInterval(() => setClock(Date.now()), 15000);
    return () => clearInterval(timer);
  }, [review]);
  useEffect(() => {
    if (!editing || review) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLeadLoading(true); setLeadError('');
      try { const data = await api.get(`/leads${qs({ q: query, contact: 'email', limit: 25, sort: 'score', dir: 'desc' })}`, { signal: controller.signal }); if (!controller.signal.aborted) setLeads(data.rows || []); }
      catch (err) { if (!controller.signal.aborted) setLeadError(err.message); } finally { if (!controller.signal.aborted) setLeadLoading(false); }
    }, 220);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, editing, review]);
  const clearReview = () => { setReview(null); setChecked({}); setOpened({}); };
  function change(key, value) { setForm((current) => ({ ...current, [key]: value })); clearReview(); setError(''); }
  function leaveDraft() { return !dirty || window.confirm('Discard the unsaved changes to this sequence?'); }
  function newSequence() {
    if (lock.current || !leaveDraft()) return;
    const next = blank(accountId); setForm(next); setSaved(next); setDetail(null); setEditing(true); setQuery(''); setError(''); clearReview();
  }
  async function select(id) {
    if (lock.current || !leaveDraft()) return; lock.current = true; setBusy('load'); setError(''); clearReview();
    try {
      const next = detailFor(await api.get(`/email/campaigns/${encodeURIComponent(id)}`));
      if (!alive.current) return;
      setDetail(next); const draft = formFor(next, accountId); setForm(draft); setSaved(draft); setEditing(next.status === 'draft');
    } catch (err) { if (alive.current) setError(err.message); } finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  async function saveDraft() {
    const validation = validateCampaign(form); if (validation) throw new Error(validation);
    const payload = campaignPayload(form);
    const next = detailFor(detail?.id ? await api.put(`/email/campaigns/${encodeURIComponent(detail.id)}`, payload) : await api.post('/email/campaigns', payload));
    if (!next?.id) throw new Error('The sequence could not be saved. Refresh the list before trying again.');
    setDetail(next); setSaved(form); await load(); return next;
  }
  async function save(event) {
    event?.preventDefault(); if (lock.current) return; lock.current = true; setBusy('save'); setError('');
    try { await saveDraft(); clearReview(); notify('Sequence draft saved. Nothing is scheduled yet.', 'success'); }
    catch (err) { if (alive.current) setError(err.message); } finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  async function prepare() {
    if (lock.current) return; lock.current = true; setBusy('review'); setError(''); setErrorCode('');
    try {
      const campaign = dirty || !detail?.id ? await saveDraft() : detail;
      const next = await api.post(`/email/campaigns/${encodeURIComponent(campaign.id)}/review`);
      if (!next.reviewToken || !Array.isArray(next.messages) || !next.messages.length) throw new Error('There are no messages ready to review. Check the recipients and sender.');
      if (alive.current) { setReview(next); setChecked({}); setOpened({}); setClock(Date.now()); }
    } catch (err) { if (alive.current) { setError(err.message); setErrorCode(err.code || ''); } } finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  const reviewMessages = review?.messages || [];
  const allChecked = reviewMessages.length > 0 && reviewMessages.every((message, index) => checked[campaignReviewKey(message, index)]);
  const expiry = review && (Number(review.expiresAt) || new Date(review.expiresAt).getTime());
  const expired = Boolean(expiry && clock >= expiry);
  async function start() {
    if (lock.current || !review || !allChecked || expired) return; lock.current = true; setBusy('start'); setError('');
    try {
      await api.post(`/email/campaigns/${encodeURIComponent(detail.id)}/start`, { reviewToken: review.reviewToken, confirmed: true });
      const next = detailFor(await api.get(`/email/campaigns/${encodeURIComponent(detail.id)}`));
      if (alive.current) { setDetail(next); setEditing(false); clearReview(); await load(); notify('Sequence started. Reviewed messages will follow your schedule.', 'success'); }
    } catch (err) {
      if (alive.current) {
        setError(`${err.message} Refresh the sequence status before trying again.`);
        // A lost response may follow an accepted start. Always reconcile first.
        try { const next = detailFor(await api.get(`/email/campaigns/${encodeURIComponent(detail.id)}`)); if (next.status !== 'draft') { setDetail(next); setEditing(false); clearReview(); await load(); } } catch { /* Keep the review; no automatic restart. */ }
      }
    } finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  async function action(kind) {
    if (lock.current || !detail?.id) return;
    if (kind === 'cancel' && !window.confirm('Cancel the remaining emails in this sequence? Already accepted messages cannot be recalled.')) return;
    lock.current = true; setBusy(kind); setError('');
    try {
      await api.post(`/email/campaigns/${encodeURIComponent(detail.id)}/${kind}`);
      const next = detailFor(await api.get(`/email/campaigns/${encodeURIComponent(detail.id)}`));
      if (alive.current) { setDetail(next); await load(); notify(kind === 'pause' ? 'Sequence paused' : kind === 'resume' ? 'Sequence resumed' : 'Remaining emails canceled', 'success'); }
    } catch (err) { if (alive.current) setError(err.message); } finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  const sender = accounts.find((item) => String(item.id) === String(form.accountId));
  const running = ['running', 'active'].includes(detail?.status);
  const totalChecked = reviewMessages.filter((message, index) => checked[campaignReviewKey(message, index)]).length;

  return <div className="page campaign-page">
    <PageHead eyebrow="Local Geni / Email" title="Sequences" description="Plan personal emails. Review every message before it is scheduled."><button className="btn primary" onClick={newSequence} disabled={Boolean(busy)}><Icon name="plus" />New sequence</button></PageHead>
    {error && <div className="email-status-note bad" role="alert"><p>{error}</p>{errorCode === 'PUBLIC_UNSUBSCRIBE_REQUIRED' && onOpenPublishing && <button className="btn xs" onClick={onOpenPublishing}>Set up unsubscribe links</button>}</div>}
    <div className="campaign-layout">
      <aside className="card campaign-library" aria-label="Saved sequences"><div className="card-head"><h3>Your sequences</h3><button className="btn xs" disabled={Boolean(busy)} onClick={load}>Refresh</button></div>{loading ? <p className="hint" role="status">Loading sequences...</p> : rows.length ? rows.map((row) => <button key={row.id} className={`campaign-list-item ${detail?.id === row.id ? 'active' : ''}`} disabled={Boolean(busy)} onClick={() => select(row.id)}><strong>{row.name}</strong><span>{CAMPAIGN_STATUS_LABELS[row.status] || row.status}</span><small>{row.counts?.sent || 0} businesses finished / {row.counts?.pending || 0} waiting</small></button>) : <p className="hint">Create a sequence when you are ready to plan your introductions and follow-ups.</p>}</aside>
      <div className="campaign-editor">
        {!editing && !detail ? <section className="card workflow-empty"><Icon name="message" /><h3>Start with a few businesses</h3><p>Choose up to 25 recipients, write your emails, and review the exact messages before starting.</p><button className="btn" onClick={newSequence}>Create a sequence</button></section>
          : review ? <section className="card form campaign-review"><div className="card-head"><div><h2 ref={reviewHeading} tabIndex={-1}>Review every email</h2><p className="hint">{totalChecked} of {reviewMessages.length} reviewed. {DAYS.filter(([day]) => form.sendWindow.days.includes(day)).map(([, label]) => label).join(', ')}: {form.sendWindow.start} to {form.sendWindow.end}, {form.timezone}.</p></div><button className="btn" disabled={Boolean(busy)} onClick={clearReview}>{detail?.status === 'paused' ? 'Back to sequence' : 'Back to draft'}</button></div><p className="hint">These are the exact messages, including opt-out wording. They will be sent only while Local Geni is running. Replies, bounces and opt-outs stop matching recipients after they are found.</p><ol className="campaign-review-list">{reviewMessages.map((message, index) => {
            const key = campaignReviewKey(message, index);
            return <li key={key}><details onToggle={(event) => { if (event.currentTarget.open) setOpened((current) => ({ ...current, [key]: true })); }}><summary><span><strong>{message.to}</strong><small>Email {Number(message.stepIndex) + 1} / {message.subject}</small></span><span>{checked[key] ? 'Reviewed' : 'Open to review'}</span></summary><dl className="workflow-message-meta"><div><dt>From</dt><dd>{message.fromName ? `${message.fromName} ` : ''}&lt;{message.fromEmail}&gt;</dd></div>{message.replyTo && <div><dt>Replies to</dt><dd>{message.replyTo}</dd></div>}<div><dt>Subject</dt><dd>{message.subject}</dd></div><div><dt>Timing</dt><dd>{Number(message.stepIndex) > 0 ? `At least ${form.steps[message.stepIndex]?.delayHours || 0} hours after the previous accepted email, within your sending window.` : 'At the next available slot in your sending window.'}</dd></div></dl><pre className="email-review-message">{message.text}</pre></details><label className="workflow-check"><input type="checkbox" checked={Boolean(checked[key])} disabled={!opened[key] || Boolean(busy)} onChange={(event) => setChecked((current) => ({ ...current, [key]: event.target.checked }))} /><span>I reviewed this exact email to {message.to}.</span></label></li>;
          })}</ol>{expired && <p role="alert" className="email-status-note bad">This review expired. Prepare a fresh review before starting.</p>}<div className="campaign-start-bar"><p className="hint">{detail?.status === 'paused' ? `Resume schedules the ${reviewMessages.length} remaining reviewed email${reviewMessages.length === 1 ? '' : 's'}. The sequence stays paused until you confirm.` : `Start schedules ${reviewMessages.length} reviewed email${reviewMessages.length === 1 ? '' : 's'}. Nothing is scheduled before you choose Start sequence.`}</p>{expired ? <button className="btn primary" onClick={prepare} disabled={Boolean(busy)}>Refresh review</button> : <button className="btn primary" disabled={!allChecked || Boolean(busy)} onClick={start}>{busy === 'start' ? 'Starting...' : detail?.status === 'paused' ? 'Resume with reviewed emails' : 'Start sequence'}</button>}</div></section>
            : editing ? <form className="form" onSubmit={save}><section className="card form"><div className="card-head"><h2>1. Choose the sender and timing</h2><span className="chip">Draft</span></div><fieldset className="form" disabled={Boolean(busy)}><label className="field"><span>Sequence name</span><input maxLength={120} required value={form.name} onChange={(event) => change('name', event.target.value)} placeholder="Toronto homepage introductions" /></label><div className="field-row"><label className="field grow"><span>Sender mailbox</span><select required value={form.accountId} onChange={(event) => change('accountId', event.target.value)}><option value="">Choose a mailbox</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.fromEmail || item.label || `Mailbox ${item.id}`}{!item.verified ? ' / not verified' : ''}</option>)}</select></label><label className="field grow"><span>Time zone</span><input required value={form.timezone} onChange={(event) => change('timezone', event.target.value)} placeholder="America/Toronto" /></label></div>{(!sender?.verified || !sender?.inbox?.verified) && <p className="hint">Sequences need a verified sender and incoming mail connection so replies can stop follow-ups.{onOpenSettings && <button type="button" className="link" onClick={onOpenSettings}> Open mailboxes</button>}</p>}<p className="hint">Unsubscribe links must also be connected so each message includes a working unsubscribe link.</p><div className="field-row"><label className="field grow"><span>Send from</span><input required type="time" value={form.sendWindow.start} onChange={(event) => change('sendWindow', { ...form.sendWindow, start: event.target.value })} /></label><label className="field grow"><span>Stop at</span><input required type="time" value={form.sendWindow.end} onChange={(event) => change('sendWindow', { ...form.sendWindow, end: event.target.value })} /></label></div><fieldset className="workflow-days"><legend>Sending days</legend>{DAYS.map(([day, label]) => <label key={day}><input type="checkbox" checked={form.sendWindow.days.includes(day)} onChange={(event) => change('sendWindow', { ...form.sendWindow, days: event.target.checked ? [...form.sendWindow.days, day] : form.sendWindow.days.filter((value) => value !== day) })} /><span>{label}</span></label>)}</fieldset><p className="hint">Outside this window, messages wait. Your sending limits still apply. Keep Local Geni running for scheduled emails to send.</p></fieldset></section>
              <section className="card form"><div className="card-head"><h2>2. Choose businesses</h2><span className="chip">{form.recipients.length} / 25</span></div><fieldset className="form" disabled={Boolean(busy)}><label className="field"><span>Find a saved business with an email</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Business name, category or location" /></label>{leadError && <p className="hint bad" role="alert">{leadError}</p>}<div className="campaign-recipient-picker">{leadLoading ? <p className="hint" role="status">Finding businesses...</p> : leads.filter((lead) => !form.recipients.some((recipient) => recipient.placeId === lead.place_id)).map((lead) => <div className="campaign-recipient-option" key={lead.place_id}><span><strong>{lead.name}</strong><small>{lead.emails?.[0] || 'No email address'}</small></span><button type="button" className="btn xs" disabled={form.recipients.length >= 25 || !lead.emails?.[0]} onClick={() => change('recipients', [...form.recipients, { placeId: lead.place_id, name: lead.name, to: lead.emails[0], emails: lead.emails }])}>Add</button></div>)}{!leadLoading && !leads.length && !leadError && <p className="hint">No matching businesses with email. Search another name or discover more leads.</p>}</div>{form.recipients.length > 0 && <ul className="campaign-recipients">{form.recipients.map((recipient) => <li key={recipient.placeId}><label className="field grow"><span>{recipient.name || recipient.to}</span><input aria-label={`Email for ${recipient.name || recipient.to}`} type="email" required maxLength={254} value={recipient.to} onChange={(event) => change('recipients', form.recipients.map((row) => row.placeId === recipient.placeId ? { ...row, to: event.target.value } : row))} /></label><button className="btn xs" type="button" onClick={() => change('recipients', form.recipients.filter((row) => row.placeId !== recipient.placeId))} aria-label={`Remove ${recipient.name || recipient.to}`}>Remove</button></li>)}</ul>}</fieldset></section>
              <section className="card form"><div className="card-head"><h2>3. Write your emails</h2><span className="chip">{form.steps.length} / 5</span></div><p className="hint">Use these fields to personalize each email: {TEMPLATES.map((name) => `{${name}}`).join(', ')}. Some fields may be blank when a business has no matching detail. Review every message.</p><fieldset className="form" disabled={Boolean(busy)}>{form.steps.map((step, index) => <section className="campaign-step form" key={index}><div className="card-head"><h3>Email {index + 1}{index ? ' / Follow-up' : ' / Introduction'}</h3>{index > 0 && <button type="button" className="btn xs" onClick={() => change('steps', form.steps.filter((_, i) => i !== index))}>Remove email</button>}</div>{index > 0 && <label className="field"><span>Wait after the previous email / hours</span><input required type="number" min={1} max={2160} value={step.delayHours} onChange={(event) => change('steps', form.steps.map((row, i) => i === index ? { ...row, delayHours: Number(event.target.value) } : row))} /></label>}<label className="field"><span>Subject</span><input required maxLength={200} value={step.subject} onChange={(event) => change('steps', form.steps.map((row, i) => i === index ? { ...row, subject: event.target.value } : row))} /></label><label className="field"><span>Message</span><textarea required rows={7} maxLength={9000} value={step.text} onChange={(event) => change('steps', form.steps.map((row, i) => i === index ? { ...row, text: event.target.value } : row))} placeholder="Write the message you want each business to receive." /></label></section>)}<button type="button" className="btn" disabled={form.steps.length >= 5} onClick={() => change('steps', [...form.steps, { subject: 'Following up, {businessName}', text: '', delayHours: 72 }])}><Icon name="plus" />Add a follow-up</button></fieldset><div className="campaign-start-bar"><p className="hint">Save a draft or review the individual emails. Nothing is scheduled yet.</p><div className="preview-actions"><button type="submit" className="btn" disabled={Boolean(busy)}>{busy === 'save' ? 'Saving...' : 'Save draft'}</button><button type="button" className="btn primary" disabled={Boolean(busy) || !sender?.verified || !sender?.inbox?.verified} onClick={prepare}>{busy === 'review' ? 'Preparing...' : 'Review every email'}</button></div></div></section></form>
              : <><section className="card form"><div className="card-head"><div><h2>{detail.name}</h2><p className="hint">{CAMPAIGN_STATUS_LABELS[detail.status] || detail.status} / {accounts.find((item) => String(item.id) === String(detail.accountId))?.fromEmail || 'Saved sender'}</p></div><button className="btn xs" disabled={Boolean(busy)} onClick={() => select(detail.id)}>Refresh status</button></div><div className="kpis campaign-kpis"><Kpi label="Businesses waiting" value={detail.counts?.pending || 0} /><Kpi label="Emails accepted" value={(detail.messages || []).filter((message) => message.status === 'sent').length} /><Kpi label="Businesses stopped" value={detail.counts?.stopped || 0} /><Kpi label="Needs attention" value={(detail.counts?.failed || 0) + (detail.counts?.unknown || 0)} /></div><p className="hint">Accepted means the provider accepted the email. It does not mean delivered or read.</p>{detail.nextRunAt && <p>Next available message: {emailTime(detail.nextRunAt)}.</p>}{(detail.holdReason || detail.lastError) && <p className="email-status-note" role="status">{detail.holdReason || detail.lastError}</p>}<p className="hint">{detail.sendWindow?.start} to {detail.sendWindow?.end}, {detail.timezone}. Scheduled emails run while Local Geni is open.</p><div className="preview-actions">{running && <button className="btn" disabled={Boolean(busy)} onClick={() => action('pause')}>Pause sequence</button>}{detail.status === 'paused' && <><button className="btn primary" disabled={Boolean(busy)} onClick={() => action('resume')}>Resume sequence</button><button className="btn" disabled={Boolean(busy)} onClick={prepare}>Review remaining emails</button></>}{(running || detail.status === 'paused') && <button className="btn ghost" disabled={Boolean(busy)} onClick={() => action('cancel')}>Cancel remaining emails</button>}</div></section><section className="card form"><h3>Message progress</h3>{detail.messages?.length ? <div className="table-wrap"><table className="table"><thead><tr><th>Recipient</th><th>Subject</th><th>Status</th><th>Details</th></tr></thead><tbody>{detail.messages.map((message, index) => <tr key={message.id || index}><td>{message.to}</td><td>{message.subject}</td><td>{EMAIL_STATUS_LABELS[message.status] || (message.status === 'pending' ? 'Waiting' : message.status === 'stopped' ? 'Stopped' : message.status)}</td><td>{message.stopReason || message.error || (message.acceptedAt ? emailTime(message.acceptedAt) : message.errorCode || '')}<details><summary>View exact email</summary><strong>{message.subject}</strong><pre className="email-review-message">{message.text}</pre></details></td></tr>)}</tbody></table></div> : <p className="hint">Message status will appear here after the sequence is started.</p>}{detail.recipients?.some((recipient) => recipient.stopReason) && <ul className="campaign-stops">{detail.recipients.filter((recipient) => recipient.stopReason).map((recipient) => <li key={recipient.placeId || recipient.to}><strong>{recipient.to}</strong><span>{recipient.stopReason}</span></li>)}</ul>}</section></>}
      </div>
    </div>
  </div>;
}
