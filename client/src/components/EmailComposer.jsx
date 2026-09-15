import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, qs } from '../lib/api.js';
import { EMAIL_STATUS_LABELS, emailSignature, emailTime, isSingleEmail } from '../lib/email.js';
import { Icon } from './ui.jsx';

const noop = () => {};
const messageStatus = (message) => message?.status || 'unknown';

export default function EmailComposer({ lead, initialSubject, initialText, accountId, inReplyTo, references, onClose, onSent, onOpenSettings, notify = noop }) {
  const initial = useRef({ to: lead?.emails?.[0] || '', subject: initialSubject || `A homepage idea for ${lead?.name || 'your business'}`, text: initialText || '' });
  const [draft, setDraft] = useState(initial.current);
  const [settings, setSettings] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState(accountId || '');
  const [settingsError, setSettingsError] = useState('');
  const [history, setHistory] = useState([]);
  const [historyError, setHistoryError] = useState('');
  const [loading, setLoading] = useState(true);
  const [review, setReview] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [verification, setVerification] = useState(null);
  const [verificationMode, setVerificationMode] = useState('dns');
  const [verificationError, setVerificationError] = useState('');
  const modalRef = useRef(null);
  const formRef = useRef(null);
  const reviewRef = useRef(null);
  const sendingRef = useRef(false);
  const closeRef = useRef(null);
  const dirtyRef = useRef(false);
  const mounted = useRef(true);
  const requestRef = useRef(null);
  const attemptRef = useRef(null);
  const connectionGeneration = useRef(0);
  const historyGeneration = useRef(0);
  const sent = messageStatus(outcome) === 'sent' && Boolean(outcome);
  const unresolved = uncertain || ['sending', 'unknown'].includes(outcome?.status);
  const edited = JSON.stringify(draft) !== JSON.stringify(initial.current);
  dirtyRef.current = edited && !sent;

  const refreshHistory = useCallback(async () => {
    const generation = ++historyGeneration.current;
    try {
      const data = await api.get(`/email/messages${qs({ placeId: lead.place_id, accountId: selectedAccountId || accountId })}`);
      if (mounted.current && generation === historyGeneration.current) { setHistory(data.rows || []); setHistoryError(''); }
      return data.rows || [];
    } catch (err) { if (mounted.current && generation === historyGeneration.current) setHistoryError(err.message); return null; }
  }, [lead.place_id, selectedAccountId, accountId]);
  const refreshConnection = useCallback(async () => {
    const generation = ++connectionGeneration.current;
    try {
      const list = await api.get('/email/accounts');
      const target = selectedAccountId || accountId || list.currentAccountId || list.rows?.[0]?.id;
      const next = await api.get(`/email/settings${qs({ accountId: target })}`);
      if (mounted.current && generation === connectionGeneration.current) { setAccounts(list.rows || []); if (!selectedAccountId && target) setSelectedAccountId(target); setSettings(next); setSettingsError(''); }
    }
    catch (err) { if (mounted.current && generation === connectionGeneration.current) setSettingsError(err.message); }
  }, [selectedAccountId, accountId]);

  useEffect(() => {
    mounted.current = true;
    let canceled = false;
    Promise.allSettled([refreshConnection(), refreshHistory()]).then(() => { if (mounted.current && !canceled) setLoading(false); });
    return () => { canceled = true; mounted.current = false; };
  }, [refreshConnection, refreshHistory]);
  useEffect(() => {
    const previous = document.activeElement;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = requestAnimationFrame(() => modalRef.current?.querySelector('input')?.focus());
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current?.(); }
      if (event.key === 'Tab') {
        const elements = [...(modalRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]') || [])].filter((element) => element.getClientRects().length);
        const first = elements[0]; const last = elements[elements.length - 1]; const current = document.activeElement;
        if (!first) { event.preventDefault(); modalRef.current?.focus(); }
        else if (event.shiftKey && (current === first || !modalRef.current?.contains(current))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (current === last || !modalRef.current?.contains(current))) { event.preventDefault(); first.focus(); }
        event.stopImmediatePropagation();
      }
    };
    const beforeUnload = (event) => { if (sendingRef.current || dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      cancelAnimationFrame(frame); document.body.style.overflow = oldOverflow;
      window.removeEventListener('keydown', onKey, true); window.removeEventListener('beforeunload', beforeUnload);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => { if (review) reviewRef.current?.focus(); }, [review]);

  function close() {
    if (sendingRef.current) { notify('Wait for the send result before closing this message.', 'info'); return; }
    if (dirtyRef.current && !window.confirm('Discard the unsaved edits to this email?')) return;
    onClose?.();
  }
  closeRef.current = close;
  function change(key, value) { setDraft((current) => ({ ...current, [key]: value })); setReview(null); setError(''); if (key === 'to') { setVerification(null); setVerificationError(''); } }
  async function verifyRecipient() {
    const email = draft.to.trim();
    if (!isSingleEmail(email)) { setVerificationError('Enter one complete recipient email address first.'); return; }
    setBusy('verify'); setVerificationError('');
    try { const result = await api.post('/email/verification', { email, mode: verificationMode }); if (mounted.current) setVerification(result); }
    catch (err) { if (mounted.current) setVerificationError(err.message); }
    finally { if (mounted.current) setBusy(''); }
  }
  async function prepare(event) {
    event?.preventDefault();
    if (busy || unresolved || sent) return;
    if (!formRef.current?.reportValidity()) return;
    const to = draft.to.trim();
    if (!isSingleEmail(to)) { setError('Use one recipient email address. Separate emails are reviewed individually.'); return; }
    if (!draft.subject.trim() || /[\r\n]/.test(draft.subject)) { setError('Add a subject on one line.'); return; }
    if (!draft.text.trim()) { setError('Add a message before reviewing.'); return; }
    setBusy('prepare'); setError('');
    try {
      const next = await api.post('/email/prepare', { placeId: lead.place_id, to, subject: draft.subject, text: draft.text, accountId: selectedAccountId || accountId, ...(inReplyTo ? { inReplyTo } : {}), ...(references?.length ? { references } : {}) });
      if (!mounted.current) return;
      if (!next.reviewToken || !next.fromEmail || !next.to || typeof next.text !== 'string') throw new Error('The email could not be prepared for review. Please try again.');
      const signature = emailSignature(next);
      if (requestRef.current?.signature !== signature) requestRef.current = { signature, key: crypto.randomUUID() };
      const existing = history.find((item) => emailSignature(item) === signature && ['sending', 'sent', 'unknown'].includes(item.status));
      if (existing) { setOutcome(existing); setReview(next); return; }
      setOutcome(null); setReview(next);
    } catch (err) { if (mounted.current) setError(err.message); }
    finally { if (mounted.current) setBusy(''); }
  }
  async function send() {
    if (!review || !requestRef.current || sendingRef.current || busy || unresolved || sent) return;
    const expiry = Number(review.expiresAt) || new Date(review.expiresAt).getTime();
    if (expiry && Date.now() >= expiry) { setReview(null); setError('This review expired. Review the message again before sending.'); return; }
    sendingRef.current = true; setBusy('send'); setError('');
    attemptRef.current = { signature: emailSignature(review), at: Date.now() };
    try {
      const result = await api.post('/email/send', { placeId: lead.place_id, to: review.to, subject: review.subject, text: review.text, expectedFromEmail: review.fromEmail, reviewToken: review.reviewToken, idempotencyKey: requestRef.current.key, confirmed: true, accountId: selectedAccountId || accountId, ...(review.inReplyTo ? { inReplyTo: review.inReplyTo } : {}), ...(review.references?.length ? { references: review.references } : {}), ...(review.unsubscribeUrl ? { unsubscribeUrl: review.unsubscribeUrl } : {}) });
      if (!mounted.current) return;
      if (!result.message) throw new Error('The provider response did not include a send result.');
      setOutcome(result.message); setUncertain(false);
      if (result.message.status === 'sent') { notify('Email accepted by your provider', 'success'); onSent?.(result.message); }
      await refreshHistory();
    } catch (err) {
      if (!mounted.current) return;
      // An HTTP validation response is definitive. A lost response may follow an accepted send.
      const ambiguous = !err.status || err.status >= 500;
      setError(err.message);
      setUncertain(ambiguous);
      const rows = await refreshHistory();
      const found = rows?.find((item) => emailSignature(item) === attemptRef.current.signature && Number(item.createdAt) >= attemptRef.current.at - 10000);
      if (found && mounted.current) {
        setOutcome(found); setUncertain(['sending', 'unknown'].includes(found.status));
        if (found.status === 'sent') { setError(''); onSent?.(found); }
      } else if (!ambiguous && ['EMAIL_REVIEW_REQUIRED', 'EMAIL_ACCOUNT_CHANGED', 'EMAIL_NOT_VERIFIED', 'EMAIL_NOT_CONFIGURED'].includes(err.code)) {
        setReview(null); await refreshConnection();
      }
    } finally { sendingRef.current = false; if (mounted.current) setBusy(''); }
  }
  async function checkOutcome() {
    setBusy('status');
    try {
      const rows = await refreshHistory();
      if (!mounted.current || !rows) return;
      const found = rows.find((item) => outcome?.id ? item.id === outcome.id : attemptRef.current && emailSignature(item) === attemptRef.current.signature && Number(item.createdAt) >= attemptRef.current.at - 10000);
      if (found) {
        setOutcome(found); setUncertain(['sending', 'unknown'].includes(found.status));
        if (found.status === 'sent') { setError(''); onSent?.(found); }
      }
    } finally { if (mounted.current) setBusy(''); }
  }
  function openSettings() {
    if (sendingRef.current) return;
    if (dirtyRef.current && !window.confirm('Discard the unsaved email edits and open email settings?')) return;
    onOpenSettings?.();
  }

  const blockedAddress = verification?.email?.toLowerCase() === draft.to.trim().toLowerCase() && ['invalid', 'bounced', 'suppressed', 'do_not_mail'].includes(verification.status);
  const canReview = settings?.verified && !loading && !busy && !unresolved && !sent && !blockedAddress;
  const controlsLocked = Boolean(busy) || unresolved || sent;
  const status = outcome?.status || (uncertain ? 'unknown' : null);

  return createPortal(<div className="email-composer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section ref={modalRef} className="email-composer-modal" role="dialog" aria-modal="true" aria-labelledby="email-composer-title" tabIndex={-1}>
      <header className="email-composer-header"><div><div className="eyebrow">Local Geni / Personal email</div><h2 id="email-composer-title">{sent ? 'Email accepted' : review ? 'Review your email' : `Email ${lead.name}`}</h2><p className="muted small">{sent ? 'Your provider has accepted this message for delivery.' : 'One recipient. A message you have reviewed.'}</p></div><button type="button" className="icon-btn" disabled={busy === 'send'} aria-label="Close email composer" onClick={close}><Icon name="close" /></button></header>
      <div className="email-composer-body">
        {loading && <p className="hint" role="status">Checking your sender account...</p>}
        {settingsError && <div className="email-status-note bad" role="alert"><p>{settingsError}</p><button className="btn xs" onClick={refreshConnection}>Check connection again</button></div>}
        {!loading && !settings?.verified && <section className="email-status-note"><Icon name="lock" /><div><strong>Connect and verify your sender account</strong><p>You can write the message now. Connect a mailbox before reviewing and sending.</p>{onOpenSettings && <button className="btn xs mt-3" onClick={openSettings}>Open email settings</button>}</div></section>}
        {error && <p className="email-status-note bad" role="alert">{error}</p>}
        {status && <section className={`email-status-note email-result-${status}`} role="status"><Icon name={status === 'sent' ? 'check' : 'alert'} /><div><strong>{EMAIL_STATUS_LABELS[status] || status}</strong><p>{status === 'sent' ? 'Acceptance does not confirm inbox delivery or that the recipient read the email.' : status === 'failed' ? outcome?.error || 'The provider did not accept this message. Nothing will be retried automatically.' : 'We cannot confirm the final outcome. Check your provider’s Sent folder or delivery logs before composing another message. Local Geni will not resend this email automatically.'}</p>{outcome?.acceptedAt && <p className="hint">{emailTime(outcome.acceptedAt)}</p>}{unresolved && <button className="btn xs mt-3" disabled={Boolean(busy)} onClick={checkOutcome}>{busy === 'status' ? 'Checking...' : 'Refresh send status'}</button>}</div></section>}

        {!review ? <form ref={formRef} id="email-compose-form" className="form" onSubmit={prepare}>
          <fieldset className="form" disabled={controlsLocked}>
            {accounts.length > 1 && !inReplyTo ? <label className="field"><span>Send from</span><select value={selectedAccountId} onChange={(event) => { setSelectedAccountId(event.target.value); setSettings(null); setLoading(true); setReview(null); setOutcome(null); setError(''); requestRef.current = null; }}><option value="" disabled>Choose a mailbox</option>{accounts.map((item) => <option key={item.id} value={item.id}>{item.fromEmail || item.label || `Mailbox ${item.id}`}{!item.verified ? ' / not verified' : ''}</option>)}</select></label> : <div className="field"><span>From</span><p className="email-readonly-value">{settings?.fromEmail ? [settings.fromName, `<${settings.fromEmail}>`].filter(Boolean).join(' ') : 'Connect an email account'}</p></div>}
            {inReplyTo && <p className="hint">Replying from the mailbox that received this message. The reply stays in the same conversation.</p>}
            <label className="field"><span>To</span><input type="email" required readOnly={Boolean(inReplyTo)} maxLength={254} list="email-lead-addresses" autoComplete="off" placeholder="owner@business.com" value={draft.to} onChange={(event) => change('to', event.target.value)} /><datalist id="email-lead-addresses">{(lead.emails || []).map((address) => <option key={address} value={address} />)}</datalist></label>
            <div className="email-verification-controls"><label className="field"><span>Address check</span><select value={verificationMode} onChange={(event) => { setVerificationMode(event.target.value); setVerification(null); setVerificationError(''); }}><option value="dns">Domain & mail records</option><option value="mailbox">Mailbox verification service</option></select></label><button type="button" className="btn" disabled={!isSingleEmail(draft.to.trim()) || Boolean(busy)} onClick={verifyRecipient}>{busy === 'verify' ? 'Checking address...' : 'Check address'}</button></div>
            {verificationMode === 'mailbox' && <p className="hint">Checking a mailbox sends this address to your connected ZeroBounce account and may use verification credits.</p>}
            {verificationError && <p className="hint" role="alert">{verificationError}</p>}
            {verification && <div className={`email-verification-result ${blockedAddress ? 'bad' : ''}`} role="status"><strong>{verification.summary || verification.status}</strong><p className="hint">{verification.mode === 'mailbox' ? 'Mailbox checks reflect the verification service’s result, not a delivery guarantee.' : 'Mail records show whether the domain can receive email. They do not confirm this mailbox exists.'}</p>{verification.checkedAt && <small className="muted">Checked {emailTime(verification.checkedAt)}</small>}</div>}
            <label className="field"><span>Subject</span><input required maxLength={200} value={draft.subject} onChange={(event) => change('subject', event.target.value)} /></label>
            <label className="field"><span>Message</span><textarea required rows={12} maxLength={10000} placeholder="Write a personal introduction..." value={draft.text} onChange={(event) => change('text', event.target.value)} /><small className="hint">{draft.text.length.toLocaleString()} characters. The final message, including your configured footer, can contain up to 10,000.</small></label>
          </fieldset>
          <p className="hint">The next step shows the exact message, including your configured opt-out line.</p>
        </form> : <section className="email-review" aria-labelledby="email-review-title"><h3 ref={reviewRef} id="email-review-title" tabIndex={-1}>Ready for your final review</h3><dl><div><dt>From</dt><dd>{review.fromName ? `${review.fromName} ` : ''}&lt;{review.fromEmail}&gt;</dd></div><div><dt>To</dt><dd>{review.to}</dd></div>{review.replyTo && <div><dt>Replies to</dt><dd>{review.replyTo}</dd></div>}<div><dt>Subject</dt><dd>{review.subject}</dd></div></dl><div className="email-review-message whitespace-pre-wrap">{review.text}</div><p className="hint">This is the exact text that will be sent from your connected mailbox.</p></section>}

        <details className="email-history"><summary>Previous emails to this business{history.length ? ` / ${history.length}` : ''}</summary>{historyError && <p className="hint bad" role="alert">{historyError}</p>}{!history.length ? <p className="hint">No recorded emails yet.</p> : <ol>{history.map((item) => <li key={item.id}><div className="email-history-head"><strong>{item.subject}</strong><span className={`chip email-result-${item.status}`}>{EMAIL_STATUS_LABELS[item.status] || item.status}</span></div><p className="hint">To {item.to} / {emailTime(item.createdAt)}</p>{item.error && <p className="hint bad">{item.error}</p>}<details><summary className="link small">View saved message</summary><p className="whitespace-pre-wrap">{item.text}</p></details></li>)}</ol>}</details>
      </div>
      <footer className="email-composer-footer"><p className="hint">{busy === 'send' ? 'Sending once. Please keep this window open.' : sent ? 'The message is saved in this business’s email history.' : 'Nothing is sent until you choose Send email.'}</p><div className="preview-actions">
        {sent || unresolved ? <button type="button" className="btn primary" disabled={busy === 'send'} onClick={close}>Close</button>
          : review ? <><button type="button" className="btn" disabled={Boolean(busy)} onClick={() => { setReview(null); setError(''); }}>Back to message</button>{outcome?.status === 'failed' ? <button type="button" className="btn primary" disabled={Boolean(busy)} onClick={() => { requestRef.current = null; setOutcome(null); setReview(null); setError(''); }}>Start a new attempt</button> : <button type="button" className="btn primary" disabled={Boolean(busy)} onClick={send}><Icon name="message" />{busy === 'send' ? 'Sending...' : 'Send email'}</button>}</>
            : <><button type="button" className="btn" disabled={busy === 'send'} onClick={close}>Cancel</button><button type="submit" form="email-compose-form" className="btn primary" disabled={!canReview}>{busy === 'prepare' ? 'Preparing review...' : 'Review email'}</button></>}
      </div></footer>
    </section>
  </div>, document.body);
}
