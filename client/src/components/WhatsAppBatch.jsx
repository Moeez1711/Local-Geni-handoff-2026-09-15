import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api.js';
import { mergeSettings, TEMPLATE_VARS } from '../lib/outreach.js';
import { batchIds, batchNumber, batchNumberSuppressed, batchPreflightError, batchPublishedNumber, batchRestriction, batchSnapshotKey, hasRecordedWhatsAppMessage, makeBatchRecipients, unsupportedBatchVariables, WHATSAPP_BATCH_LIMIT } from '../lib/whatsappBatch.js';
import { Icon } from './ui.jsx';
import WhatsAppApiBatch from './WhatsAppApiBatch.jsx';
import '../whatsapp-batch.css';
import '../whatsapp-workspace.css';

const noop = () => {};

export default function WhatsAppBatch({ selectedIDs, settings, notify = noop, onClose, onChanged, onOpenSettings, initialMode = 'manual', initialMessage = '' }) {
  const configured = useMemo(() => mergeSettings(settings), [settings]);
  const [template, setTemplate] = useState(() => initialMessage || configured.templates.general);
  const initialTemplate = useRef(template);
  const [entries, setEntries] = useState([]);
  const [suppressions, setSuppressions] = useState([]);
  const [recipients, setRecipients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [recordError, setRecordError] = useState('');
  const [step, setStep] = useState('template');
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState('');
  const [personalEdits, setPersonalEdits] = useState(false);
  const [mode, setMode] = useState(initialMode === 'api' ? 'api' : 'manual');
  const [apiDirty, setApiDirty] = useState(false); const [apiBusy, setApiBusy] = useState(false); const [apiSubmitted, setApiSubmitted] = useState(false);
  const modal = useRef(null); const heading = useRef(null); const editor = useRef(null);
  const alive = useRef(true); const lock = useRef(false); const closeRef = useRef(null);
  const guard = useRef(false); const apiBusyRef = useRef(false); const keys = useRef(new Map());
  const initialIds = useRef(selectedIDs);
  const manualEntries = useMemo(() => entries.map(entry => ({ ...entry, whatsappSuppressed: batchNumberSuppressed(batchNumber(entry.lead), suppressions) })), [entries, suppressions]);
  const current = recipients.find(row => row.id === selectedId);
  const selected = recipients.filter(row => row.included);
  const recorded = row => row.sentMessage === row.message || hasRecordedWhatsAppMessage(row);
  const confirmed = selected.filter(recorded).length;
  apiBusyRef.current = apiBusy;
  guard.current = !apiSubmitted && (apiDirty || template !== initialTemplate.current || (personalEdits && recipients.some(row => row.included && !recorded(row))));

  useEffect(() => {
    alive.current = true; const controller = new AbortController();
    let ids; try { ids = batchIds(initialIds.current); } catch (err) { setError(err.message); setLoading(false); return () => { alive.current = false; }; }
    Promise.all(ids.map(async id => {
      try { const detail = await api.get(`/previews/${encodeURIComponent(id)}`, { signal: controller.signal }); return { id, ...detail }; }
      catch (err) { return { id, error: err.message }; }
    })).then(async rows => {
      if (controller.signal.aborted || !alive.current) return;
      setEntries(rows);
      const numbers = [...new Set(rows.map(entry => batchNumber(entry.lead)).filter(Boolean))];
      try {
        const result = numbers.length ? await api.get(`/whatsapp/suppressions?numbers=${encodeURIComponent(numbers.join(','))}`, { signal: controller.signal }) : { rows: [] };
        if (!Array.isArray(result.rows)) throw new Error('WhatsApp permission checks could not be loaded.');
        if (!controller.signal.aborted && alive.current) setSuppressions(result.rows);
      } catch (err) { if (!controller.signal.aborted && alive.current) setError(`${err.message} Permission will be checked again before any chat opens.`); }
      finally { if (!controller.signal.aborted && alive.current) setLoading(false); }
    });
    return () => { alive.current = false; controller.abort(); };
  }, []);
  useEffect(() => {
    const previous = document.activeElement; const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; const frame = requestAnimationFrame(() => heading.current?.focus());
    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current?.(); }
      if (event.key !== 'Tab') return;
      const controls = [...(modal.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]') || [])].filter(element => element.getClientRects().length);
      const first = controls[0]; const last = controls.at(-1); const active = document.activeElement;
      if (!first) { event.preventDefault(); modal.current?.focus(); }
      else if (event.shiftKey && (active === first || !modal.current?.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !modal.current?.contains(active))) { event.preventDefault(); first.focus(); }
      event.stopImmediatePropagation();
    };
    const unload = event => { if (guard.current || lock.current || apiBusyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('keydown', onKey, true); window.addEventListener('beforeunload', unload);
    return () => { cancelAnimationFrame(frame); document.body.style.overflow = overflow; window.removeEventListener('keydown', onKey, true); window.removeEventListener('beforeunload', unload); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { heading.current?.focus(); }, [step, mode]);

  function close() {
    if (lock.current || apiBusy) { notify('Wait for the current WhatsApp request to finish.', 'info'); return; }
    if (guard.current && !window.confirm('Close this batch and discard unsaved message edits? Recorded sent confirmations are kept.')) return;
    onClose?.();
  }
  closeRef.current = close;
  function chooseMode(next) {
    if (lock.current || apiBusy || apiSubmitted || next === mode) return;
    if (mode === 'api' && apiDirty && !window.confirm('Discard the unsent API template changes and switch to manual chat drafts?')) return;
    setMode(next); setError(''); setRecordError('');
  }
  function openSettings() {
    if (lock.current || apiBusy) return;
    if (guard.current && !window.confirm('Discard unsaved message edits and open WhatsApp settings?')) return;
    onOpenSettings?.();
  }
  function update(id, patch) { setRecipients(rows => rows.map(row => row.id === id ? { ...row, ...patch } : row)); }
  function review(recommended = false) {
    if (lock.current || loading) return;
    setError('');
    if (!recommended && !template.trim()) { setError('Write a shared message first.'); editor.current?.focus(); return; }
    const unsupported = recommended ? [] : unsupportedBatchVariables(template);
    if (unsupported.length) { setError(`Replace these unknown template fields: ${unsupported.join(', ')}.`); editor.current?.focus(); return; }
    const drafts = makeBatchRecipients(manualEntries, template, configured, recommended).map(row => {
      const prior = recipients.find(item => item.id === row.id);
      return prior && recorded(prior) ? prior : row;
    });
    setRecipients(drafts); setSelectedId(drafts.find(row => row.included && !recorded(row))?.id || drafts[0]?.id || '');
    setPersonalEdits(false); setStep('review'); setRecordError('');
  }
  function back() {
    if (lock.current) return;
    if (personalEdits && !window.confirm('Return to the shared template? Preparing new messages will replace unsent individual edits. Sent confirmations stay saved.')) return;
    setStep('template'); setRecordError('');
  }
  function insertVariable(value) {
    const input = editor.current; const start = input?.selectionStart ?? template.length; const end = input?.selectionEnd ?? start;
    setTemplate(current => current.slice(0, start) + value + current.slice(end));
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + value.length, start + value.length); });
  }
  function toggleIncluded(row, included) {
    if (row.restriction) return;
    if (included && recipients.some(other => other.id !== row.id && other.included && other.number === row.number)) { setError('These businesses share a phone number. Include only one to avoid opening the same chat twice.'); return; }
    update(row.id, { included }); setError('');
  }
  async function openDraft(row) {
    if (lock.current || !row.reviewed || !row.included || row.restriction || !row.number || !row.message.trim() || row.message.length > 10000 || recorded(row)) return;
    const message = row.message;
    lock.current = true; setBusy(`open:${row.id}`); setRecordError('');
    const snapshot = batchSnapshotKey(row.id, row.number, message);
    if (!keys.current.has(snapshot)) keys.current.set(snapshot, crypto.randomUUID());
    try {
      const fresh = await api.get(`/previews/${encodeURIComponent(row.id)}`);
      const permission = await api.get(`/whatsapp/suppressions?number=${encodeURIComponent(row.number)}`);
      if (!Array.isArray(permission.rows)) throw new Error('The current WhatsApp permission check could not be completed.');
      fresh.whatsappSuppressed = batchNumberSuppressed(row.number, permission.rows);
      if (fresh.whatsappSuppressed && alive.current) setSuppressions(rows => [...rows.filter(item => item.number !== row.number), { number: row.number }]);
      if (fresh?.lead && alive.current) setEntries(rows => rows.map(entry => entry.id === row.id ? { id: row.id, ...fresh, whatsappSuppressed: undefined } : entry));
      const invalid = batchPreflightError(row, fresh);
      if (invalid) {
        if (fresh?.lead && alive.current) update(row.id, { lead: fresh.lead, preview: fresh.preview, activity: fresh.activity, number: batchNumber(fresh.lead), publishedNumber: batchPublishedNumber(fresh.lead), restriction: batchRestriction(fresh), included: false, reviewed: false, openedMessage: null });
        throw new Error(invalid);
      }
      const activity = await api.post(`/previews/${encodeURIComponent(row.id)}/activity`, { kind: 'draft_opened', channel: 'whatsapp', message, idempotencyKey: `wa-open:${keys.current.get(snapshot)}` });
      const latestPermission = await api.get(`/whatsapp/suppressions?number=${encodeURIComponent(row.number)}`);
      if (!Array.isArray(latestPermission.rows)) throw new Error('The final WhatsApp permission check could not be completed.');
      activity.whatsappSuppressed = batchNumberSuppressed(row.number, latestPermission.rows);
      if (activity.whatsappSuppressed && alive.current) setSuppressions(rows => [...rows.filter(item => item.number !== row.number), { number: row.number }]);
      if (activity?.lead && alive.current) setEntries(rows => rows.map(entry => entry.id === row.id ? { id: row.id, ...activity, whatsappSuppressed: undefined } : entry));
      const changed = batchPreflightError(row, activity);
      if (changed) {
        if (activity?.lead && alive.current) update(row.id, { lead: activity.lead, preview: activity.preview, activity: activity.activity, number: batchNumber(activity.lead), publishedNumber: batchPublishedNumber(activity.lead), restriction: batchRestriction(activity), included: false, reviewed: false, openedMessage: null });
        throw new Error(changed);
      }
      update(row.id, { openedMessage: message, activity: activity.activity || row.activity, publishedNumber: batchPublishedNumber(activity.lead) });
      onChanged?.();
    } catch (err) {
      if (alive.current) {
        if (err.status === 404) { update(row.id, { included: false, reviewed: false, openedMessage: null, error: 'This business is no longer available. Refresh your leads.' }); setEntries(rows => rows.map(entry => entry.id === row.id ? { id: row.id, error: 'This business is no longer available. Refresh your leads.' } : entry)); }
        setRecordError(`${err.message} The draft stayed in Local Geni and nothing was marked sent.`);
      }
    } finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  async function confirmSent(row) {
    if (lock.current || !row.included || !row.reviewed || row.openedMessage !== row.message || recorded(row)) return;
    lock.current = true; setBusy(row.id); setRecordError('');
    const message = row.openedMessage; const snapshot = batchSnapshotKey(row.id, row.number, message);
    if (!keys.current.has(snapshot)) keys.current.set(snapshot, crypto.randomUUID());
    try {
      const detail = await api.post(`/previews/${encodeURIComponent(row.id)}/activity`, { kind: 'sent', channel: 'whatsapp', message, idempotencyKey: `wa-sent:${keys.current.get(snapshot)}` });
      if (alive.current) { update(row.id, { sentMessage: message, activity: detail.activity || row.activity }); notify(`Sent confirmation saved for ${row.lead.name}`, 'success'); }
      onChanged?.();
    } catch (err) { if (alive.current) setRecordError(`Your confirmation was not saved: ${err.message} Retry saving the confirmation; do not send the message again.`); }
    finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  async function copyMessage(row) {
    try { await navigator.clipboard.writeText(row.message); notify('Message copied', 'success'); } catch { notify('Select the message text and copy it manually.', 'info'); }
  }
  const nextRecipient = current && selected.find(row => !recorded(row) && row.id !== current.id);
  const currentRecorded = current && recorded(current);
  const readyToOpen = current?.included && !current?.restriction && current?.number && current?.reviewed && current.message.trim() && current.message.length <= 10000 && !currentRecorded;

  return createPortal(<div className="whatsapp-batch-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) close(); }}>
    <section className="whatsapp-batch-modal" ref={modal} role="dialog" aria-modal="true" aria-labelledby="whatsapp-batch-title" tabIndex={-1}>
      <header className="whatsapp-batch-header"><div><p className="eyebrow">Local Geni / WhatsApp</p><h2 id="whatsapp-batch-title" ref={heading} tabIndex={-1}>{mode === 'api' ? 'Send through WhatsApp Business' : step === 'template' ? 'Message selected businesses' : 'Review your WhatsApp chats'}</h2><p className="hint">{mode === 'api' ? 'Approved templates, recorded permission and a final message review.' : step === 'template' ? `Prepare a personal message for up to ${WHATSAPP_BATCH_LIMIT} selected businesses.` : `${confirmed} of ${selected.length} included businesses recorded as sent.`}</p></div><button className="icon-btn" aria-label="Close WhatsApp batch" disabled={Boolean(busy) || apiBusy} onClick={close}><Icon name="close" /></button></header>
      <div className="whatsapp-batch-body">
        <div className="whatsapp-mode-choice" role="group" aria-label="How to send WhatsApp messages"><button type="button" className={mode === 'manual' ? 'active' : ''} aria-pressed={mode === 'manual'} disabled={Boolean(busy) || apiBusy || apiSubmitted} onClick={() => chooseMode('manual')}><strong>Prepare personal chats</strong><span>Review and copy each message here. Nothing opens automatically.</span></button><button type="button" className={mode === 'api' ? 'active' : ''} aria-pressed={mode === 'api'} disabled={Boolean(busy) || apiBusy || apiSubmitted} onClick={() => chooseMode('api')}><strong>Send with Business API</strong><span>Send reviewed templates from inside Local Geni through Meta.</span></button></div>
        {mode === 'manual' && <p className="whatsapp-batch-note"><strong>Nothing leaves Local Geni automatically.</strong> Prepare and copy the reviewed message here, then open WhatsApp yourself if needed. Choose Business API to send from inside Local Geni.</p>}
        {error && <p className="whatsapp-batch-error" role="alert">{error}</p>}
        {loading ? <p role="status" className="hint">Loading the selected businesses...</p> : mode === 'api' ? <WhatsAppApiBatch entries={entries} settings={settings} notify={notify} onChanged={onChanged} onDirtyChange={setApiDirty} onBusyChange={setApiBusy} onSubmittedChange={setApiSubmitted} onOpenSettings={onOpenSettings ? openSettings : undefined} onClose={close} /> : step === 'template' ? <div className="whatsapp-template-layout">
          <section className="form"><label className="field"><span>Shared message template</span><textarea ref={editor} value={template} onChange={event => { setTemplate(event.target.value); setError(''); }} rows={11} maxLength={8000} placeholder="Hi {name} team,..." /></label><div className="whatsapp-template-fields" aria-label="Insert a personalization field">{['{name}', '{contactName}', '{category}', '{specificImprovement}', '{signoff}'].map(value => <button type="button" key={value} className="btn xs" onClick={() => insertVariable(value)}>{value}</button>)}</div><p className="hint">Names are filled in separately for each business. You can edit each message before copying it.</p><details><summary>All available fields</summary><p className="hint">{TEMPLATE_VARS.filter(value => value !== '{previewUrl}').join(', ')}</p></details></section>
          <aside className="whatsapp-batch-selection"><h3>Selected businesses</h3>{makeBatchRecipients(manualEntries, template, configured).map(row => <div className="whatsapp-selected-business" key={row.id}><strong>{row.lead?.name || 'Business unavailable'}</strong><span>{row.error || row.restriction || (row.number ? `+${row.number}` : 'No usable international phone number')}</span>{row.number && <small>{row.publishedNumber ? 'WhatsApp link published on its website' : 'Phone number only. WhatsApp not verified.'}</small>}{row.duplicateOf && <small>Same number as {row.duplicateOf}. Only one can be included.</small>}</div>)}<p className="hint">A published WhatsApp link is a listing fact, not a guarantee that someone will reply.</p></aside>
        </div> : <div className="whatsapp-review-layout">
          <aside className="whatsapp-recipient-list" aria-label="Businesses in this batch">{recipients.map(row => <div key={row.id} className={`whatsapp-recipient-item ${row.id === selectedId ? 'active' : ''}`}><label><input type="checkbox" checked={row.included} disabled={Boolean(busy) || !row.number || Boolean(row.error) || Boolean(row.restriction) || recorded(row)} onChange={event => toggleIncluded(row, event.target.checked)} aria-label={`Include ${row.lead?.name || 'business'}`} /></label><button type="button" disabled={Boolean(busy)} aria-pressed={row.id === selectedId} onClick={() => { setSelectedId(row.id); setRecordError(''); }}><strong>{row.lead?.name || 'Business unavailable'}</strong><span>{row.error ? 'Could not load' : row.restriction ? 'Excluded by status' : !row.number ? 'Phone missing' : recorded(row) ? 'Sent recorded' : !row.included ? 'Excluded' : row.openedMessage === row.message ? 'Draft opened' : row.reviewed ? 'Reviewed' : 'Needs review'}</span></button></div>)}</aside>
          {current && <section className="whatsapp-recipient-editor form" aria-label={`Message for ${current.lead?.name || 'business'}`}><div className="card-head"><div><h3>{current.lead?.name || 'Business unavailable'}</h3><p className="hint">{current.number ? `+${current.number}` : 'No usable international phone number'}</p></div>{current.number && <span className="chip">{current.publishedNumber ? 'Website WhatsApp link' : 'WhatsApp unverified'}</span>}</div>
            {current.error ? <p className="whatsapp-batch-error">{current.error}</p> : <>
              {!current.included && <p className="whatsapp-batch-note">{current.restriction || `This business is excluded. ${current.number ? 'Select its checkbox to include it.' : 'Add a phone number to the business before preparing a WhatsApp chat.'}`}</p>}
              <label className="field"><span>Exact message for {current.lead.name}</span><textarea rows={11} maxLength={10000} value={current.message} readOnly={currentRecorded} disabled={Boolean(busy)} onChange={event => { update(current.id, { message: event.target.value, reviewed: false, openedMessage: null }); setPersonalEdits(true); setRecordError(''); }} /><small className="hint">{current.message.length.toLocaleString()} / 10,000 characters</small></label>
              {currentRecorded ? <p className="whatsapp-batch-success" role="status">This exact message is recorded as sent. Your confirmation is saved in the business activity history.</p> : <label className="whatsapp-reviewed"><input type="checkbox" checked={current.reviewed} disabled={Boolean(busy) || !current.included || !current.message.trim() || current.message.length > 10000} onChange={event => update(current.id, { reviewed: event.target.checked })} /><span>I reviewed this exact message and recipient.</span></label>}
              <div className="whatsapp-chat-actions"><button type="button" className="btn" disabled={Boolean(busy) || !current.message.trim()} onClick={() => copyMessage(current)}>Copy message</button><button type="button" className="btn primary" disabled={!readyToOpen || Boolean(busy)} onClick={() => openDraft(current)}>{busy === `open:${current.id}` ? 'Preparing…' : 'Prepare in Local Geni'}</button></div>
              {current.openedMessage === current.message && !currentRecorded && <div className="whatsapp-send-confirmation"><p>Draft prepared in Local Geni. Copy it, then open WhatsApp yourself if you want to send it.</p><button type="button" className="btn primary" disabled={Boolean(busy) || !current.included || !current.reviewed} onClick={() => confirmSent(current)}>{busy ? 'Saving confirmation...' : recordError ? 'Retry saving sent confirmation' : 'I sent this'}</button><small>Local Geni cannot check whether WhatsApp sent or delivered the message.</small></div>}
              {recordError && <p className="whatsapp-batch-error" role="alert">{recordError}</p>}
            </>}
          </section>}
        </div>}
      </div>
      {mode === 'manual' && <footer className="whatsapp-batch-footer"><p className="hint">{step === 'template' ? 'Nothing is sent from this window.' : 'Only your explicit sent confirmation updates contact history.'}</p><div className="preview-actions">{step === 'template' ? <><button type="button" className="btn" disabled={loading || !entries.some(row => row.lead)} onClick={() => review(true)}>Use saved business pitches</button><button type="button" className="btn primary" disabled={loading || !entries.some(row => row.lead) || !template.trim()} onClick={() => review()}>Review personalized messages</button></> : <><button type="button" className="btn" disabled={Boolean(busy)} onClick={back}>Edit shared template</button>{nextRecipient ? <button type="button" className="btn primary" disabled={Boolean(busy)} onClick={() => { setSelectedId(nextRecipient.id); setRecordError(''); }}>Next business</button> : <button type="button" className="btn primary" disabled={Boolean(busy)} onClick={close}>Done</button>}</>}</div></footer>}
    </section>
  </div>, document.body);
}
