import { useCallback, useEffect, useRef, useState } from 'react';
import { api, qs } from '../lib/api.js';
import { isPublicPreviewUrl, PREVIEW_STAGES, previewMessage } from '../lib/previews.js';
import { Icon, IconButton, MetricStrip, PageHead } from './ui.jsx';
import FinishedPageFiles from './FinishedPageFiles.jsx';

const STAGES = Object.fromEntries(PREVIEW_STAGES);
const STAGE_ICONS = { shortlisted: 'list', designing: 'design', ready: 'check', shared: 'send', replied: 'message', call_booked: 'calendar', won: 'trophy', lost: 'close' };
const StageBadge = ({ stage = 'shortlisted' }) => <span className={`design-stage ${stage}`}><Icon name={STAGE_ICONS[stage] || 'list'} size={13}/>{STAGES[stage] || 'Shortlisted'}</span>;
const ACTIVITY_LABELS = { draft_opened: 'Draft opened', sent: 'Sent message recorded', reply: 'Reply received', call_booked: 'Call booked' };
const CHANNELS = [['email', 'Email'], ['whatsapp', 'WhatsApp'], ['phone', 'Phone'], ['other', 'Other']];
const pathFor = (id) => `/previews/${encodeURIComponent(id)}`;
const noop = () => {};
const formFor = (preview = {}) => ({
  publicUrl: preview.publicUrl || '', contactName: preview.contactName || '',
  stage: preview.stage || 'shortlisted', pitchNote: preview.improvements?.[0] || '',
  minutesSpent: preview.minutesSpent ?? 0, dealValue: preview.dealValue ?? 0,
});

export default function PreviewWorkspace({ initialPlaceId, onOpenLead, onComposeEmail, notify = noop, onChanged, settings = {}, onDirtyChange, onBusyChange }) {
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({});
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [filter, setFilter] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [leadQuery, setLeadQuery] = useState('');
  const [leadRows, setLeadRows] = useState([]);
  const [leadLoading, setLeadLoading] = useState(false);
  const [leadError, setLeadError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState('');
  const [fileBusy, setFileBusy] = useState(false);
  const [fileDirty, setFileDirty] = useState(false);
  const [error, setError] = useState('');
  const [channel, setChannel] = useState('email');
  const searchRef = useRef(null);
  const headingRef = useRef(null);
  const requestId = useRef(0);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const dirtyRef = useRef(false);
  const selectRef = useRef(null);
  const activityKey = useRef(null);
  const formDirty = Boolean(form && JSON.stringify(form) !== JSON.stringify(saved));
  const dirty = formDirty || fileDirty;
  busyRef.current = Boolean(busy) || fileBusy;
  dirtyRef.current = dirty;

  const refresh = useCallback(async () => {
    setListError('');
    try { const result = await api.get('/previews'); if (alive.current) { setRows(result.rows || []); setSummary(result.summary || {}); } }
    catch (err) { if (alive.current) setListError(err.message); }
    finally { if (alive.current) setListLoading(false); }
  }, []);
  useEffect(() => { alive.current = true; refresh(); return () => { alive.current = false; requestId.current += 1; }; }, [refresh]);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(Boolean(busy) || fileBusy); return () => onBusyChange?.(false); }, [busy, fileBusy, onBusyChange]);
  useEffect(() => {
    const guard = (event) => { if (dirtyRef.current || busyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, []);
  useEffect(() => {
    if (!choosing) return undefined;
    const controller = new AbortController(); setLeadLoading(true); setLeadError('');
    const timer = setTimeout(async () => {
      try { const data = await api.get(`/leads${qs({ q: leadQuery, limit: 20 })}`, { signal: controller.signal }); if (!controller.signal.aborted) setLeadRows(data.rows || []); }
      catch (err) { if (!controller.signal.aborted) setLeadError(err.message); }
      finally { if (!controller.signal.aborted) setLeadLoading(false); }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [choosing, leadQuery]);
  useEffect(() => { if (choosing) searchRef.current?.focus(); }, [choosing]);

  function apply(next) { const values = formFor(next.preview); setDetail(next); setForm(values); setSaved(values); }
  async function selectProject(id) {
    if (busyRef.current) return;
    if (id === selectedId && detail) { setChoosing(false); return; }
    if (dirtyRef.current && !window.confirm('Discard unsaved changes and open another business?')) return;
    const sequence = ++requestId.current; busyRef.current = true; setBusy('load'); setError('');
    setSelectedId(id); setDetail(null); setForm(null); setSaved(null); setChoosing(false); activityKey.current = null;
    try { const next = await api.get(pathFor(id)); if (sequence === requestId.current && alive.current) { apply(next); setChannel('email'); } }
    catch (err) { if (sequence === requestId.current && alive.current) setError(err.message); }
    finally { if (sequence === requestId.current && alive.current) { busyRef.current = false; setBusy(''); } }
  }
  selectRef.current = selectProject;
  useEffect(() => { if (initialPlaceId) selectRef.current(initialPlaceId); }, [initialPlaceId]);
  useEffect(() => { if (detail) headingRef.current?.focus(); }, [selectedId, Boolean(detail)]);
  function change(key, value) { setForm((current) => ({ ...current, [key]: value })); setError(''); }
  async function save(event) {
    event.preventDefault(); if (busyRef.current || !form) return;
    if (form.publicUrl.trim() && !isPublicPreviewUrl(form.publicUrl)) { setError('Use a public HTTPS design link. Local, private, and example addresses cannot be shared.'); return; }
    if (form.stage === 'ready' && !isPublicPreviewUrl(form.publicUrl)) { setError('Add a public design link before marking this business Ready to share.'); return; }
    busyRef.current = true; setBusy('save'); setError('');
    try {
      // Update only CRM fields. Existing design assets and private project notes are preserved.
      const next = await api.put(pathFor(selectedId), {
        publicUrl: form.publicUrl.trim(), contactName: form.contactName, stage: form.stage,
        improvements: [form.pitchNote, ...(detail.preview.improvements || []).slice(1)].filter((value) => value.trim()),
        minutesSpent: Number(form.minutesSpent), dealValue: Number(form.dealValue),
      });
      if (alive.current) { apply(next); await refresh(); onChanged?.(); notify('Design link saved', 'success'); }
    } catch (err) { if (alive.current) setError(err.message); }
    finally { busyRef.current = false; if (alive.current) setBusy(''); }
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(detail.preview.publicUrl); notify('Design link copied', 'success'); }
    catch { notify('Select the design URL and copy it manually.', 'error'); }
  }
  function compose() {
    if (busyRef.current || dirty || !publicReady || !onComposeEmail) return;
    const id = selectedId, sequence = requestId.current;
    onComposeEmail(detail.lead, message, `A homepage idea for ${detail.lead.name}`, async () => {
      try { const next = await api.get(pathFor(id)); if (alive.current && sequence === requestId.current && !dirtyRef.current) apply(next); await refresh(); onChanged?.(); }
      catch (err) { notify(err.message, 'error'); }
    });
  }
  async function record(kind) {
    if (busyRef.current || dirty || !detail.preview.updatedAt) return;
    const signature = `${selectedId}:${kind}:${channel}`;
    if (activityKey.current?.signature !== signature) activityKey.current = { signature, key: crypto.randomUUID() };
    busyRef.current = true; setBusy('activity'); setError('');
    try {
      const next = await api.post(`${pathFor(selectedId)}/activity`, { kind, channel, message: '', idempotencyKey: activityKey.current.key });
      if (alive.current) { apply(next); await refresh(); onChanged?.(); notify(`${ACTIVITY_LABELS[kind]} recorded`, 'success'); }
      activityKey.current = null;
    } catch (err) { if (alive.current) setError(err.message); }
    finally { busyRef.current = false; if (alive.current) setBusy(''); }
  }

  const projects = rows.map((row) => ({ ...row, ...(row.preview || {}), name: row.lead?.name || row.name, category: row.lead?.category || row.category, place_id: row.place_id || row.lead?.place_id || row.preview?.place_id }));
  const filtered = projects.filter((row) => (!stageFilter || row.stage === stageFilter) && `${row.name || ''} ${row.category || ''}`.toLowerCase().includes(filter.toLowerCase()));
  const publicReady = isPublicPreviewUrl(detail?.preview?.publicUrl);
  const message = previewMessage(detail?.lead, detail?.preview, settings);
  const locked = Boolean(busy) || fileBusy;
  const actionLocked = locked || dirty || !publicReady;
  const activity = detail?.activity || [];

  return <div className="page preview-page">
    <PageHead eyebrow="Local Geni / CRM" title="Design links"><button className="btn primary" disabled={locked} onClick={() => setChoosing((current) => !current)}><Icon name="plus" />Choose business</button></PageHead>
    <MetricStrip label="Design pipeline" items={[
      { label: 'Businesses', value: summary.total ?? projects.length, icon: 'building' },
      { label: 'Ready to share', value: summary.ready || 0, icon: 'check', tone: 'blue' },
      { label: 'Sent', value: summary.shared || 0, icon: 'send', tone: 'violet' },
      { label: 'Replied', value: summary.replied || 0, icon: 'message', tone: 'amber' },
      { label: 'Won', value: summary.won || 0, icon: 'trophy', tone: 'green' },
    ]}/>
    <div className="preview-layout">
      <aside className="card preview-library" aria-label="Businesses with design links">
        <div className="card-head"><h3>Businesses</h3><span className="muted small">{filtered.length}</span></div>
        <label className="crm-search"><Icon name="search" size={15}/><input aria-label="Search businesses" type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Find a business" /></label>
        <label className="field"><span className="sr-only">Filter by stage</span><select value={stageFilter} onChange={(event) => setStageFilter(event.target.value)}><option value="">All stages</option>{PREVIEW_STAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {listError && <p className="hint bad" role="alert">{listError} <button className="link" onClick={refresh}>Retry</button></p>}
        <div className="preview-project-list" aria-busy={listLoading}>{listLoading ? <p className="hint">Loading businesses...</p> : filtered.map((row) => <button key={row.place_id} className={`preview-project ${selectedId === row.place_id ? 'active' : ''}`} aria-pressed={selectedId === row.place_id} disabled={locked} onClick={() => selectProject(row.place_id)}><span className="preview-project-avatar" aria-hidden="true">{row.name?.trim().charAt(0).toUpperCase() || <Icon name="building" size={16}/>}</span><span className="preview-project-text"><strong>{row.name}</strong><StageBadge stage={row.stage}/></span></button>)}{!listLoading && !listError && !filtered.length && <p className="hint">{projects.length ? 'No businesses match these filters.' : 'No businesses'}</p>}</div>
      </aside>
      <div className="preview-editor">
        {choosing && <section className="card form" aria-label="Choose business"><div className="card-head"><h3>Choose lead</h3><button className="icon-btn" aria-label="Close business picker" onClick={() => setChoosing(false)}><Icon name="close" /></button></div><label className="field"><span>Search saved leads</span><input ref={searchRef} type="search" value={leadQuery} onChange={(event) => setLeadQuery(event.target.value)} placeholder="Business name" /></label>{leadError && <p className="hint bad" role="alert">{leadError}</p>}{leadLoading ? <p className="hint" role="status">Finding businesses...</p> : leadRows.map((lead) => <button className="preview-project" key={lead.place_id} disabled={locked} onClick={() => selectProject(lead.place_id)}><span className="preview-project-text"><strong>{lead.name}</strong><span>{lead.category || 'Local business'}</span></span></button>)}{!leadLoading && !leadError && !leadRows.length && <p className="hint">No matching leads</p>}</section>}
        {error && <p className="email-status-note bad" role="alert">{error}</p>}
        {busy === 'load' ? <section className="card" role="status">Loading business...</section> : !detail ? !choosing && <section className="card workflow-empty"><Icon name="link" /><h3>Choose business</h3><button className="btn" onClick={() => setChoosing(true)}>Choose business</button></section> : <>
          <header className="design-business-head">
            <span className="design-business-icon"><Icon name="building" size={21}/></span>
            <div className="grow"><h2 ref={headingRef} tabIndex={-1}>{detail.lead.name}</h2><p>{detail.lead.category || 'Local business'}</p></div>
            <StageBadge stage={detail.preview.stage}/>
            {onOpenLead && <IconButton icon="arrowUpRight" label="Business details" disabled={locked} onClick={() => onOpenLead(selectedId)}/>}
          </header>
          <div className="design-detail-layout">
          <form className="card form design-edit-card" onSubmit={save}>
            <div className="design-section-head"><h3><Icon name="design" size={17}/>Design details</h3><span className={`design-save-state ${formDirty ? 'pending' : ''}`} role="status"><Icon name={formDirty ? 'edit' : 'check'} size={13}/>{formDirty ? 'Unsaved' : detail.preview.updatedAt ? 'Saved' : 'New'}</span></div>
            <fieldset className="form" disabled={locked}>
              <label className="field"><span>Design URL <em>· public HTTPS link</em></span><input type="url" maxLength={2000} value={form.publicUrl} onChange={(event) => change('publicUrl', event.target.value)} placeholder="https://your-design-site.com/business" /></label>
              <label className="field"><span>Pitch note</span><textarea rows={3} maxLength={300} value={form.pitchNote} onChange={(event) => change('pitchNote', event.target.value)} placeholder="What makes this design better for the business?" /></label>
              <div className="field-row design-contact-fields"><label className="field"><span>Contact name <em>· optional</em></span><input maxLength={120} value={form.contactName} onChange={(event) => change('contactName', event.target.value)} placeholder="Owner or manager" /></label><label className="field"><span>Sales stage</span><select value={form.stage} onChange={(event) => change('stage', event.target.value)}>{PREVIEW_STAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
              <details><summary>Project details</summary><div className="form mt-3"><div className="field-row"><label className="field grow"><span>Time spent / minutes</span><input type="number" min={0} max={10000000} step={1} value={form.minutesSpent} onChange={(event) => change('minutesSpent', event.target.value)} /></label><label className="field grow"><span>Project value / your currency</span><input type="number" min={0} max={1000000000} step="0.01" value={form.dealValue} onChange={(event) => change('dealValue', event.target.value)} /></label></div>{detail.preview.brief && <div><strong>Saved private notes</strong><p className="whitespace-pre-wrap">{detail.preview.brief}</p></div>}{(detail.preview.improvements || []).slice(1).filter(Boolean).length > 0 && <div><strong>Earlier pitch notes</strong><ul>{detail.preview.improvements.slice(1).filter(Boolean).map((note, index) => <li key={index}>{note}</li>)}</ul><p className="hint">These saved notes are also included in the introduction.</p></div>}</div></details>
              <div className="preview-actions design-save-actions"><button className="btn primary" disabled={locked || (!formDirty && detail.preview.updatedAt)}><Icon name="check" size={15}/>{busy === 'save' ? 'Saving...' : 'Save changes'}</button>{formDirty && <button type="button" className="btn ghost" onClick={() => { setForm(saved); setError(''); }}>Discard</button>}</div>
            </fieldset>
          </form>
          <section className="card design-share-card" aria-labelledby="design-link-email-heading">
            <div className="design-section-head"><h3 id="design-link-email-heading"><Icon name="send" size={17}/>Share design</h3></div>
            {publicReady ? <>
              <div className="design-link-preview"><span className="design-link-symbol"><Icon name="globe" size={23}/></span><span className="design-link-label">Saved design</span><a href={detail.preview.publicUrl} target="_blank" rel="noreferrer" title={detail.preview.publicUrl}>{new URL(detail.preview.publicUrl).hostname}<Icon name="external" size={14}/></a><div className="design-link-actions"><a className="btn" href={detail.preview.publicUrl} target="_blank" rel="noreferrer"><Icon name="eye" size={15}/>Open design</a><IconButton icon="copy" label="Copy design link" disabled={actionLocked} onClick={copyLink}/></div></div>
              <details className="design-introduction"><summary><Icon name="mail" size={15}/>Email introduction</summary><pre className="email-review-message">{message}</pre></details>
              <button className="btn primary design-compose" disabled={actionLocked || !onComposeEmail} onClick={compose}><Icon name="mail" size={16}/>Compose email<Icon name="arrowUpRight" size={16}/></button>
              <p className={`hint ${dirty ? 'design-share-warning' : ''}`}>{formDirty ? 'Save changes before composing.' : fileDirty ? 'Save or discard your file to continue.' : 'Opens a draft for review.'}</p>
            </> : <div className="design-share-empty"><Icon name="link" size={27}/><strong>Add your design link</strong><p>Save a public HTTPS URL to preview and share it.</p></div>}
          </section>
          <details className="card design-disclosure design-files"><summary><Icon name="codeFile" size={17}/><span>Finished HTML</span><small>{fileDirty ? 'File selected' : 'Files & versions'}</small><Icon name="next" size={16}/></summary><FinishedPageFiles key={selectedId} placeId={selectedId} disabled={Boolean(busy)} notify={notify} onBusyChange={setFileBusy} onDirtyChange={setFileDirty} onSaved={async () => { const next = await api.get(pathFor(selectedId)); if (formDirty) setDetail(next); else apply(next); await refresh(); onChanged?.(); }} /></details>
          <details className="card design-disclosure design-activity"><summary><Icon name="activity" size={17}/><span>Activity</span><small>{activity.length} {activity.length === 1 ? 'event' : 'events'}</small><Icon name="next" size={16}/></summary><div className="form design-disclosure-body"><p className="hint">Email activity is automatic. Record other conversations here.</p><div className="field-row"><label className="field"><span>Conversation channel</span><select value={channel} disabled={locked} onChange={(event) => setChannel(event.target.value)}>{CHANNELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="btn" disabled={locked || dirty || !detail.preview.updatedAt} onClick={() => record('reply')}><Icon name="message" size={15}/>Record reply</button><button className="btn" disabled={locked || dirty || !detail.preview.updatedAt} onClick={() => record('call_booked')}><Icon name="calendar" size={15}/>Record booked call</button></div>{activity.length ? <ol className="preview-activity">{activity.map((item) => <li key={item.id}><span className="preview-activity-dot" /><div><strong>{ACTIVITY_LABELS[item.kind] || item.kind}</strong><p className="hint">{item.channel} / {new Date(item.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</p>{item.message && <details><summary>View saved message</summary><pre className="email-review-message">{item.message}</pre></details>}</div></li>)}</ol> : <p className="hint">No activity</p>}</div></details>
          </div>
        </>}
      </div>
    </div>
  </div>;
}
