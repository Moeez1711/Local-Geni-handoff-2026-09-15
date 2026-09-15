import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { changedCustomFieldIds, customFieldDisplay, customValuesDraft, customValuesPatch } from '../lib/customFields.js';
import '../custom-fields.css';

const noop = () => {};
export default function LeadCustomFields({ placeId, notify = noop, onDirtyChange, onBusyChange, onChanged, onManageFields, readOnly = false }) {
  const [detail, setDetail] = useState(null); const [draft, setDraft] = useState({}); const [saved, setSaved] = useState({});
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [fieldErrors, setFieldErrors] = useState({}); const [conflict, setConflict] = useState(false);
  const alive = useRef(true); const lock = useRef(false); const guard = useRef(false); const activeId = useRef(placeId); const form = useRef(null);
  activeId.current = placeId;
  const definitions = detail?.definitions || []; const activeFields = definitions.filter(field => !field.archived);
  const archivedValues = definitions.filter(field => field.archived && detail.values?.[field.id] != null && detail.values[field.id] !== '');
  const dirty = changedCustomFieldIds(definitions, draft, saved).length > 0; guard.current = dirty;
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { const unload = event => { if (guard.current || lock.current) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', unload); return () => window.removeEventListener('beforeunload', unload); }, []);
  function receive(data) {
    if (data?.placeId !== activeId.current || !Array.isArray(data.definitions) || !Number.isInteger(data.version) || !Number.isInteger(data.definitionsVersion)) throw new Error('The saved field values could not be loaded safely. Reload them to continue.');
    setDetail(data); const values = customValuesDraft(data.definitions, data.values); setDraft(values); setSaved(values); setFieldErrors({}); setError(''); setConflict(false);
  }
  useEffect(() => {
    alive.current = true; const controller = new AbortController(); const id = placeId; setLoading(true); setDetail(null); setDraft({}); setSaved({}); setError(''); setFieldErrors({}); setConflict(false);
    api.get(`/custom-fields/leads/${encodeURIComponent(id)}`, { signal: controller.signal }).then(data => { if (!controller.signal.aborted && id === activeId.current) receive(data); }).catch(err => { if (!controller.signal.aborted) setError(err.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); alive.current = false; };
  }, [placeId]);
  function change(field, value) { setDraft(current => ({ ...current, [field.id]: value })); setFieldErrors(current => ({ ...current, [field.id]: '' })); }
  function canLeave() { return !lock.current && (!dirty || window.confirm('Discard the unsaved custom field values for this business?')); }
  async function reload() {
    if (!canLeave()) return; lock.current = true; setBusy(true); setError(''); const id = placeId;
    try { const data = await api.get(`/custom-fields/leads/${encodeURIComponent(id)}`); if (alive.current && id === activeId.current) receive(data); }
    catch (err) { if (alive.current && id === activeId.current) setError(err.message); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function save(event) {
    event.preventDefault(); if (readOnly || lock.current || !detail || detail.placeId !== placeId || !dirty) return;
    const patch = customValuesPatch(definitions, draft, saved); setFieldErrors(patch.errors); setError('');
    const firstInvalid = Object.keys(patch.errors)[0];
    if (firstInvalid) { requestAnimationFrame(() => form.current?.querySelector(`[data-field-id="${CSS.escape(firstInvalid)}"]`)?.focus()); return; }
    if (!form.current?.reportValidity()) return;
    lock.current = true; setBusy(true); const id = placeId;
    try {
      const data = await api.put(`/custom-fields/leads/${encodeURIComponent(id)}`, { version: detail.version, definitionsVersion: detail.definitionsVersion, values: patch.values });
      if (alive.current && id === activeId.current) { receive(data); notify('Custom field values saved', 'success'); onChanged?.(); }
    } catch (err) { if (alive.current && id === activeId.current) { setError(err.message); setConflict(err.status === 409); } }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  function reset() { if (!canLeave()) return; setDraft(saved); setFieldErrors({}); setError(''); }
  function renderInput(field) {
    const id = `custom-value-${field.id}`; const errorId = `${id}-error`; const value = draft[field.id];
    const common = { id, 'data-field-id': field.id, disabled: busy || readOnly, 'aria-invalid': Boolean(fieldErrors[field.id]), 'aria-describedby': fieldErrors[field.id] ? errorId : undefined };
    if (readOnly) return <div className="custom-field-readonly" id={id}>{customFieldDisplay(detail.values?.[field.id])}</div>;
    if (field.type === 'textarea') return <textarea {...common} rows={4} maxLength={5000} value={value ?? ''} onChange={event => change(field, event.target.value)} />;
    if (field.type === 'select') return <select {...common} value={value ?? ''} onChange={event => change(field, event.target.value)}><option value="">Not set</option>{value && !(field.options || []).includes(value) && <option value={value}>{value} (saved option)</option>}{(field.options || []).map(option => <option key={option} value={option}>{option}</option>)}</select>;
    if (field.type === 'checkbox') return <select {...common} value={value == null ? '' : value ? 'true' : 'false'} onChange={event => change(field, event.target.value === '' ? null : event.target.value === 'true')}><option value="">Not set</option><option value="true">Yes</option><option value="false">No</option></select>;
    return <input {...common} type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : field.type === 'url' ? 'url' : 'text'} step={field.type === 'number' ? 'any' : undefined} min={field.type === 'number' ? -1e15 : undefined} max={field.type === 'number' ? 1e15 : undefined} maxLength={field.type === 'url' ? 2048 : field.type === 'text' ? 500 : undefined} value={value ?? ''} onChange={event => change(field, event.target.value)} placeholder={field.type === 'url' ? 'https://business.com' : undefined} />;
  }
  return <section className="d-sec lead-custom-fields"><div className="sec-head"><h4>Custom fields</h4>{onManageFields && <button type="button" className="btn xs ghost" disabled={busy} onClick={() => { if (canLeave()) onManageFields(); }}>{readOnly ? 'View fields' : 'Manage fields'}</button>}</div>
    {loading ? <p className="muted small" role="status">Loading saved field values...</p> : <>
      {error && <div className="custom-fields-error" role="alert"><p>{error}</p>{conflict && <p>This business or its fields changed in another window. Your edits are kept. Reload saved values before editing again.</p>}<button type="button" className="btn xs" disabled={busy} onClick={reload}>Reload saved values</button></div>}
      {detail && <form ref={form} className="form custom-values-form" onSubmit={save} noValidate>{activeFields.length ? <><div className="custom-values-grid">{activeFields.map(field => <div className={`field custom-value-field ${field.type === 'textarea' ? 'wide' : ''}`} key={field.id}><label htmlFor={`custom-value-${field.id}`}>{field.label}</label>{renderInput(field)}{fieldErrors[field.id] && <small className="custom-field-error" id={`custom-value-${field.id}-error`} role="alert">{fieldErrors[field.id]}</small>}</div>)}</div>{!readOnly && <div className="custom-values-actions"><span className={`custom-field-save-status ${dirty ? 'dirty' : ''}`} role="status">{busy ? 'Saving...' : dirty ? 'Unsaved changes' : 'Saved'}</span><div className="preview-actions"><button type="button" className="btn xs" disabled={busy || !dirty} onClick={reset}>Discard edits</button><button className="btn xs primary" disabled={busy || !dirty || conflict}>{busy ? 'Saving...' : 'Save field values'}</button></div></div>}<p className="hint">{readOnly ? 'You have view access to these saved values.' : 'Values are saved only when you choose Save field values. Empty fields remain unset.'}</p></> : <p className="muted small">No active custom fields yet. Add fields in Data & fields to keep more details on each business.</p>}
      {archivedValues.length > 0 && <details className="custom-archived-values"><summary>Archived field values ({archivedValues.length})</summary><dl>{archivedValues.map(field => <div key={field.id}><dt>{field.label}</dt><dd>{customFieldDisplay(detail.values[field.id])}</dd></div>)}</dl><p className="hint">These values are kept. Restore the field in Data & fields to edit them.</p></details>}</form>}
    </>}
  </section>;
}
