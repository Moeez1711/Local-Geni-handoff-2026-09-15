import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api.js';
import { smsLength } from '../../../shared/sms.js';
import { Icon } from './ui.jsx';
import ProviderIcon from './ProviderIcon.jsx';
import '../messaging.css';

const PROVIDERS = [
  ['twilio', 'Twilio'],
  ['telnyx', 'Telnyx'],
  ['vonage', 'Vonage'],
];
const FAILED = new Set(['failed', 'unknown', 'undelivered', 'submitting']);

export default function SmsComposer({ lead, initialMessage = '', onClose, onSent, onOpenSettings, notify }) {
  const initial = useRef({ recipient: lead?.phone_e164 || '', body: initialMessage || '' });
  const modal = useRef(null);
  const heading = useRef(null);
  const previousFocus = useRef(null);
  const closeRef = useRef(() => {});
  const alive = useRef(true);
  const [draft, setDraft] = useState(initial.current);
  const [connections, setConnections] = useState([]);
  const [simulated, setSimulated] = useState(false);
  const [provider, setProvider] = useState('twilio');
  const [loading, setLoading] = useState(true);
  const [review, setReview] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState(null);

  const connection = connections.find(item => item.id === provider);
  const ready = Boolean(connection?.verified);
  const length = smsLength(draft.body);
  const dirty = draft.recipient !== initial.current.recipient || draft.body !== initial.current.body || consent || review;

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    api.get('/sms/connections', { signal: controller.signal }).then(result => {
      if (!alive.current) return;
      const rows = Array.isArray(result?.rows) ? result.rows : [];
      setConnections(rows);
      setSimulated(Boolean(result?.simulated));
      const verified = rows.find(item => item.verified);
      if (verified) setProvider(verified.id);
    }).catch(err => {
      if (alive.current && !controller.signal.aborted) setError(err.message || 'SMS providers could not be loaded.');
    }).finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; controller.abort(); };
  }, []);

  useEffect(() => {
    previousFocus.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = requestAnimationFrame(() => heading.current?.focus());
    const onKeyDown = event => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab' || !modal.current) return;
      const controls = [...modal.current.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]')]
        .filter(element => element.getClientRects().length);
      if (!controls.length) { event.preventDefault(); modal.current.focus(); return; }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (previousFocus.current instanceof HTMLElement && previousFocus.current.isConnected) previousFocus.current.focus({ preventScroll: true });
    };
  }, []);

  function close() {
    if (busy) { notify?.('Wait for the SMS request to finish.', 'info'); return; }
    if (!outcome && dirty && !window.confirm('Close this SMS draft and discard your edits?')) return;
    onClose?.();
  }
  closeRef.current = close;

  function change(key, value) {
    setDraft(current => ({ ...current, [key]: value }));
    setReview(false);
    setOutcome(null);
    setError('');
  }

  function chooseProvider(next) {
    if (busy || review) return;
    setProvider(next);
    setReview(false);
    setOutcome(null);
    setError('');
  }

  async function send() {
    if (busy || !ready || !review) return;
    const recipient = draft.recipient.trim();
    const body = draft.body.trim();
    if (!recipient || !body || !consent) {
      setError('Enter a recipient, write a message, and confirm SMS permission.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api.post('/sms/messages', {
        provider,
        recipient,
        body,
        consent: true,
        confirmed: true,
        requestId: crypto.randomUUID(),
        connectionRevision: connection.revision,
      });
      if (!alive.current) return;
      const message = result?.message;
      setOutcome(message || { status: 'accepted' });
      if (FAILED.has(message?.status)) {
        setError(message?.error || 'The provider did not confirm this message. Check SMS history before trying again.');
      } else {
        notify?.(simulated ? 'Sample SMS accepted' : 'SMS accepted by provider', 'success');
        onSent?.(message);
      }
    } catch (err) {
      if (alive.current) setError(err.message || 'SMS could not be sent.');
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  if (!lead) return null;
  const statusLabel = outcome?.status || (loading ? 'Loading providers' : ready ? 'Ready to send' : 'Connection needed');

  return createPortal(
    <div className="sms-composer-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) close(); }}>
      <section className="sms-composer-modal" ref={modal} role="dialog" aria-modal="true" aria-labelledby="sms-composer-title" tabIndex={-1}>
        <header className="sms-composer-header">
          <div>
            <p className="eyebrow">Local Geni / SMS</p>
            <h2 id="sms-composer-title" ref={heading} tabIndex={-1}>Message {lead.name}</h2>
            <p className="hint">Review the recipient and message here. Nothing sends until you confirm.</p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close SMS composer" disabled={busy} onClick={close}><Icon name="close" size={18} /></button>
        </header>

        <div className="sms-composer-body">
          <div className={`sms-composer-status ${ready ? 'ready' : 'error'}`} role="status">
            <span>{statusLabel}{connection?.metadata?.fromNumber ? ` · From ${connection.metadata.fromNumber}` : ''}</span>
            {!ready && !loading && <button type="button" className="btn xs" onClick={() => { if (!dirty || window.confirm('Discard this SMS draft and open settings?')) onOpenSettings?.(); }}>Open SMS settings</button>}
          </div>
          {error && <p className="sms-composer-status error" role="alert">{error}</p>}

          {loading ? <p className="hint" role="status">Loading SMS providers…</p> : !review ? <form className="form" onSubmit={event => { event.preventDefault(); if (!ready) return; setReview(true); setError(''); }}>
            <div className="sms-composer-provider">
              <span className="field-label">Provider</span>
              {PROVIDERS.map(([id, label]) => <button type="button" key={id} className={provider === id ? 'on' : ''} aria-label={label} aria-pressed={provider === id} title={label} onClick={() => chooseProvider(id)}><ProviderIcon provider={id} size={19} /></button>)}
            </div>
            <p className="sms-composer-sender hint">{connection?.metadata?.fromNumber ? `Messages send from ${connection.metadata.fromNumber}.` : `Connect and verify ${PROVIDERS.find(([id]) => id === provider)?.[1] || provider} before sending.`}</p>
            <label className="field"><span>To</span><input type="tel" required pattern="[+][0-9 ()-]{7,22}" placeholder="+1 415 555 0123" value={draft.recipient} onChange={event => change('recipient', event.target.value)} /></label>
            <label className="field"><span>Message</span><textarea rows={5} required maxLength={1600} placeholder="Write a short, useful message…" value={draft.body} onChange={event => change('body', event.target.value)} /></label>
            <div className="sms-composer-meta"><span>{draft.body.length.toLocaleString()} / 1,600 characters</span><span>{length.segments || 0} {length.segments === 1 ? 'segment' : 'segments'}</span></div>
            <label className="system-auto-check"><input type="checkbox" required checked={consent} onChange={event => { setConsent(event.target.checked); setError(''); }} /><span>I have permission to text this recipient.</span></label>
            <footer className="sms-composer-footer"><button type="button" className="btn" disabled={busy} onClick={close}>Cancel</button><button type="submit" className="btn primary" disabled={!ready || busy || !draft.recipient.trim() || !draft.body.trim() || !consent}><Icon name="check" size={15} />Review SMS</button></footer>
          </form> : <div className="form">
            <div className="sms-composer-review">
              <dl><dt>To</dt><dd>{draft.recipient.trim()}</dd><dt>Provider</dt><dd>{PROVIDERS.find(([id]) => id === provider)?.[1] || provider}</dd></dl>
              <p>{draft.body.trim()}</p>
            </div>
            <p className="hint">{simulated ? 'Sample mode. No SMS is delivered.' : 'This sends a real SMS from your connected number.'}</p>
            {outcome && !error && <p className="sms-composer-status ready" role="status">Message {outcome.status || 'accepted'}.</p>}
            <footer className="sms-composer-footer"><button type="button" className="btn" disabled={busy} onClick={() => { setReview(false); setOutcome(null); }}>Edit</button>{outcome && !error ? <button type="button" className="btn primary" onClick={close}>Done</button> : <button type="button" className="btn primary" disabled={busy || !ready} onClick={send}><Icon name="send" size={15} />{busy ? 'Sending…' : simulated ? 'Simulate send' : 'Send SMS'}</button>}</footer>
          </div>}
        </div>
      </section>
    </div>,
    document.body,
  );
}
