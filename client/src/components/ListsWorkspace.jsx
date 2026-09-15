import { useEffect, useRef, useState } from 'react';
import { api, qs, LEAD_STATUSES } from '../lib/api.js';
import { Icon, IconButton, PageHead } from './ui.jsx';
import '../crm.css';

const empty = () => ({ name: '', kind: 'static', filters: {}, memberIds: [] });
const shortlistName = () => `Shortlist · ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date())}`;
export default function ListsWorkspace({ initialSelection, onConsumedSelection, onEmailCampaign, onWhatsApp, onOpenLead, notify, onDirtyChange, onBusyChange, readOnly = false, canOutreach = true }) {
  const [library, setLibrary] = useState([]), [archived, setArchived] = useState(false);
  const [detail, setDetail] = useState(null), [rows, setRows] = useState([]), [total, setTotal] = useState(0), [page, setPage] = useState(0);
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(empty), [saved, setSaved] = useState(empty);
  const [selected, setSelected] = useState(() => new Set()), [query, setQuery] = useState(''), [matches, setMatches] = useState([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(''), [loading, setLoading] = useState(true);
  const [exclusions, setExclusions] = useState([]), [handoff, setHandoff] = useState(null);
  const [memberPage, setMemberPage] = useState(0), [memberRetry, setMemberRetry] = useState(0);
  const [memberPreview, setMemberPreview] = useState({ query: '', rows: [], loading: false, error: '' });
  const memberPages = Math.max(1, Math.ceil(draft.memberIds.length / 20));
  const memberOffset = Math.min(memberPage, memberPages - 1) * 20;
  const memberIds = draft.memberIds.slice(memberOffset, memberOffset + 20);
  const memberQuery = memberIds.join(',');
  const alive = useRef(true), lock = useRef(false), requestKey = useRef(''), handled = useRef(null), guard = useRef(false);
  const dirty = editing && JSON.stringify(draft) !== JSON.stringify(saved);
  guard.current = dirty || Boolean(busy);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    alive.current = true;
    const unload = event => { if (guard.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => { alive.current = false; window.removeEventListener('beforeunload', unload); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true);
    api.get(`/lists${qs({ archived })}`, { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setLibrary(data.rows || []); }).catch(err => { if (!controller.signal.aborted) setError(err.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [archived]);
  useEffect(() => {
    if (!initialSelection || handled.current === initialSelection) return;
    handled.current = initialSelection;
    startNew(initialSelection.ids || [], initialSelection.kind || 'static', initialSelection.name || '');
    onConsumedSelection?.();
  }, [initialSelection]);
  useEffect(() => {
    if (!editing || draft.kind !== 'static' || query.trim().length < 2) { setMatches([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.get(`/leads${qs({ q: query, limit: 12 })}`, { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setMatches(data.rows || []); }).catch(err => { if (!controller.signal.aborted) setError(err.message); });
    }, 220);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, editing, draft.kind]);
  useEffect(() => { setMemberPage(current => Math.min(current, memberPages - 1)); }, [memberPages]);
  useEffect(() => {
    if (!editing || draft.kind !== 'static' || !memberQuery) { setMemberPreview({ query: '', rows: [], loading: false, error: '' }); return; }
    const controller = new AbortController();
    setMemberPreview({ query: memberQuery, rows: [], loading: true, error: '' });
    api.get(`/leads${qs({ ids: memberQuery, limit: 20, includeClosed: true })}`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setMemberPreview({ query: memberQuery, rows: data.rows || [], loading: false, error: '' }); })
      .catch(() => { if (!controller.signal.aborted) setMemberPreview({ query: memberQuery, rows: [], loading: false, error: 'Could not load the selected businesses. Your selection is unchanged.' }); });
    return () => controller.abort();
  }, [editing, draft.kind, memberQuery, memberRetry]);
  function canLeave() { return !lock.current && (!dirty || window.confirm('Discard the unsaved list changes?')); }
  async function refreshLibrary() { const data = await api.get(`/lists${qs({ archived })}`); if (alive.current) setLibrary(data.rows || []); }
  async function run(name, fn) {
    if (lock.current) return;
    lock.current = true; setBusy(name); setError('');
    try { await fn(); } catch (err) { if (alive.current) setError(err.message); }
    finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  function startNew(ids = [], kind = 'static', name = '') {
    if (readOnly || !canLeave()) return;
    const next = { ...empty(), kind, name: name || (ids.length && kind === 'static' ? shortlistName() : ''), memberIds: [...new Set(ids)] };
    if (next.memberIds.length > 1000) { setError('Choose up to 1,000 businesses for one list.'); return; }
    requestKey.current = crypto.randomUUID(); setDetail(null); setDraft(next); setSaved(empty()); setEditing(true);
    setMemberPage(0);
    setRows([]); setTotal(0); setPage(0); setSelected(new Set()); setExclusions([]); setHandoff(null); setQuery(''); setError('');
  }
  async function receive(id, nextPage = 0) {
    const data = await api.get(`/lists/${encodeURIComponent(id)}${qs({ limit: 100, offset: nextPage * 100 })}`);
    if (!alive.current) return;
    setDetail(data.list); setRows(data.rows || []); setTotal(data.total); setPage(nextPage); setSelected(new Set()); setExclusions([]); setHandoff(null);
    const next = { name: data.list.name, kind: data.list.kind, filters: data.list.filters, memberIds: data.list.memberIds };
    setDraft(next); setSaved(next); setEditing(false);
  }
  function open(id, nextPage = 0) { if (canLeave()) run('load', () => receive(id, nextPage)); }
  function change(key, value) { setDraft(current => ({ ...current, [key]: value })); setError(''); }
  function filter(key, value) { setDraft(current => ({ ...current, filters: { ...current.filters, [key]: value } })); }
  function save(event) {
    event.preventDefault(); if (readOnly) return;
    if (draft.kind === 'static' && !draft.memberIds.length) { setError('Add at least one business before saving this list.'); return; }
    run('save', async () => {
      const record = detail ? await api.put(`/lists/${encodeURIComponent(detail.id)}`, { ...draft, version: detail.version }) : await api.post('/lists', { ...draft, requestKey: requestKey.current });
      await receive(record.id); await refreshLibrary(); notify?.('List saved', 'success');
    });
  }
  function preview() { run('preview', async () => { const data = await api.post('/lists/preview', { filters: draft.filters }); if (alive.current) { setRows(data.rows || []); setTotal(data.total); setSelected(new Set()); } }); }
  function archive() {
    if (readOnly || !detail || !canLeave()) return;
    const restore = Boolean(detail.archivedAt);
    if (!restore && !window.confirm(`Archive "${detail.name}"? Its businesses stay saved.`)) return;
    run('archive', async () => {
      const record = await api.post(`/lists/${encodeURIComponent(detail.id)}/${restore ? 'restore' : 'archive'}`, { version: detail.version });
      await receive(record.id); await refreshLibrary();
    });
  }
  function prepare(channel) {
    if (!selected.size || selected.size > 25 || !canOutreach) return;
    run('recipients', async () => {
      const data = await api.post(`/lists/${encodeURIComponent(detail.id)}/recipients`, { ids: [...selected], channel });
      if (!alive.current) return;
      if (!data.rows.length) { setExclusions(data.excluded); setHandoff(null); throw new Error('No selected businesses have an eligible contact.'); }
      if (data.excluded.length) { setExclusions(data.excluded); setHandoff({ channel, data }); }
      else deliver(channel, data);
    });
  }
  function deliver(channel, data) {
    if (channel === 'email') onEmailCampaign?.({ id: crypto.randomUUID(), name: data.name, recipients: data.rows });
    else onWhatsApp?.(data.rows.map(row => row.placeId));
  }
  function toggle(id) { setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); setExclusions([]); setHandoff(null); }
  const disabled = Boolean(busy);
  return <div className="page lists-workspace">
    <PageHead title="Lists & segments">{!readOnly && <div className="preview-actions"><button className="btn" disabled={disabled} onClick={() => startNew([], 'segment')}><Icon name="settings" size={15}/>New segment</button><button className="btn primary" disabled={disabled} onClick={() => startNew()}><Icon name="plus" />New list</button></div>}</PageHead>
    {error && <p className="crm-error" role="alert">{error}</p>}
    <div className="lists-layout">
      <aside className="card lists-library"><div className="seg"><button className={!archived ? 'on' : ''} disabled={disabled} onClick={() => { if (canLeave()) { setArchived(false); setDetail(null); setEditing(false); } }}>Active</button><button className={archived ? 'on' : ''} disabled={disabled} onClick={() => { if (canLeave()) { setArchived(true); setDetail(null); setEditing(false); } }}>Archived</button></div>
        {loading ? <p role="status">Loading lists...</p> : library.map(item => <button key={item.id} className={`list-library-item ${detail?.id === item.id ? 'active' : ''}`} aria-pressed={detail?.id === item.id} disabled={disabled} onClick={() => open(item.id)}><strong>{item.name}</strong><span>{item.kind === 'segment' ? 'Live segment' : 'Saved list'}<b>{item.count.toLocaleString()}</b></span></button>)}
        {!loading && !library.length && <p className="hint">{archived ? 'No archived lists' : 'No lists'}</p>}
      </aside>
      <section className="lists-content">
        {editing ? <form className="card form" onSubmit={save}><div className="card-head"><h2>{detail ? 'Edit' : 'New'} {draft.kind === 'segment' ? 'segment' : 'list'}</h2><span className="chip">{dirty ? 'Unsaved' : 'Saved'}</span></div>{draft.kind === 'static' && draft.memberIds.length > 0 && <p className="list-source-note"><Icon name="leads" size={15}/> {draft.memberIds.length} businesses selected from Leads. Review the selection, name the list, then save it.</p>}<fieldset className="form" disabled={disabled}>
          <label className="field"><span>Name</span><input autoFocus required maxLength={120} value={draft.name} onChange={event => change('name', event.target.value)} placeholder="Toronto website prospects" /></label>
          {draft.kind === 'segment' ? <><div className="crm-filter-grid">
            <label className="field"><span>Search words</span><input type="search" value={draft.filters.q || ''} maxLength={200} onChange={event => filter('q', event.target.value)} placeholder="Business, location or notes" /></label>
            <label className="field"><span>Category</span><input value={draft.filters.category || ''} maxLength={200} onChange={event => filter('category', event.target.value)} placeholder="Exact saved category" /></label>
            <label className="field"><span>Country code</span><input value={draft.filters.country || ''} maxLength={2} onChange={event => filter('country', event.target.value.toUpperCase())} placeholder="CA" /></label>
            <label className="field"><span>Priority</span><select value={draft.filters.tier || ''} onChange={event => filter('tier', event.target.value)}><option value="">Any priority</option><option value="hot">Hot lead</option><option value="potential">Potential</option><option value="low">Low priority</option></select></label>
            <label className="field"><span>Status</span><select value={draft.filters.leadStatus || ''} onChange={event => filter('leadStatus', event.target.value)}><option value="">Any status</option>{LEAD_STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="field"><span>Contact method</span><select value={draft.filters.contact || ''} onChange={event => filter('contact', event.target.value)}><option value="">Any</option><option value="email">Email</option><option value="phone">Phone</option><option value="whatsapp">Published WhatsApp</option></select></label>
            <label className="field"><span>Minimum rating</span><input type="number" min={0} max={5} step="0.1" value={draft.filters.minRating ?? ''} onChange={event => filter('minRating', event.target.value)} /></label>
            <label className="field"><span>Minimum lead score</span><input type="number" min={0} max={100} value={draft.filters.minScore ?? ''} onChange={event => filter('minScore', event.target.value)} /></label>
          </div><p className="hint">All filters must match. Empty filters include all active businesses.</p><button type="button" className="btn" onClick={preview}><Icon name="eye" size={15}/>Preview matches</button></> : <>
            <label className="field"><span>Add saved businesses</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search at least two characters" /></label>
            <div className="list-add-results">{matches.map(lead => <div key={lead.place_id}><span>{lead.name}</span><IconButton icon={draft.memberIds.includes(lead.place_id) ? 'check' : 'plus'} label={`${draft.memberIds.includes(lead.place_id) ? 'Added' : 'Add'} ${lead.name}`} disabled={draft.memberIds.includes(lead.place_id) || draft.memberIds.length >= 1000} onClick={() => change('memberIds', [...draft.memberIds, lead.place_id])}/></div>)}</div>
            <section className="shortlist-review" aria-label="Businesses to save">
              <div className="card-head"><h3>Selected businesses</h3><span className="chip" role="status">{draft.memberIds.length}</span></div>
              {memberPreview.loading || (memberQuery && memberPreview.query !== memberQuery) ? <p className="hint" role="status">Loading your selection…</p> : memberPreview.error ? <div role="alert"><p className="hint">{memberPreview.error}</p><button className="btn" type="button" onClick={() => setMemberRetry(value => value + 1)}><Icon name="refresh" size={14}/>Retry selection</button></div> : memberIds.map(id => {
                const row = memberPreview.rows.find(item => item.place_id === id);
                return <div className="list-member-edit" key={id}><span><strong>{row?.name || 'Business unavailable'}</strong><small>{row ? [row.category, row.address].filter(Boolean).join(' · ') : 'This business may have been removed. Remove it from this list to continue.'}</small></span><IconButton icon="close" label={`Remove ${row?.name || 'unavailable business'}`} onClick={() => change('memberIds', draft.memberIds.filter(value => value !== id))}/></div>;
              })}
              {!draft.memberIds.length && <p className="hint">Search above to add businesses to this list.</p>}
              {memberPages > 1 && <div className="crm-pagination"><button className="btn" type="button" disabled={!memberPage} onClick={() => setMemberPage(value => value - 1)}>Previous</button><span>{memberOffset + 1}–{Math.min(memberOffset + 20, draft.memberIds.length)} of {draft.memberIds.length}</span><button className="btn" type="button" disabled={memberPage >= memberPages - 1} onClick={() => setMemberPage(value => value + 1)}>Next</button></div>}
            </section>
          </>}
        </fieldset><div className="preview-actions"><button className="btn primary" disabled={disabled || (draft.kind === 'static' && !draft.memberIds.length)}>Save {draft.kind === 'segment' ? 'segment' : 'list'}</button><button type="button" className="btn" disabled={disabled} onClick={() => { if (canLeave()) { setEditing(false); setDraft(saved); } }}>Cancel</button></div></form> : detail ? <div className="card list-detail-head"><div><p className="eyebrow">{detail.archivedAt ? 'Archived' : detail.kind === 'segment' ? 'Live segment' : 'Saved list'}</p><h2>{detail.name}</h2><p className="hint">{total.toLocaleString()} {total === 1 ? 'business' : 'businesses'}</p></div><div className="preview-actions">{!readOnly && !detail.archivedAt && <IconButton icon="edit" label="Edit list" disabled={disabled} onClick={() => { setEditing(true); setQuery(''); }}/>}<IconButton icon="refresh" label="Refresh list" disabled={disabled} onClick={() => open(detail.id)}/>{!readOnly && <IconButton icon={detail.archivedAt ? 'restore' : 'archive'} label={detail.archivedAt ? 'Restore list' : 'Archive list'} disabled={disabled} onClick={archive}/>}</div></div> : <section className="card crm-empty"><Icon name="leads" /><h2>Choose a list</h2></section>}
        {exclusions.length > 0 && <div className="card form" role="status"><h3>{exclusions.length} businesses excluded</h3><ul>{exclusions.map(row => <li key={row.placeId}>{row.name}: {row.reason}</li>)}</ul>{handoff && <button className="btn primary" disabled={disabled} onClick={() => deliver(handoff.channel, handoff.data)}>Continue with {handoff.data.rows.length} recipients</button>}</div>}
        {((detail && !detail.archivedAt && !editing) || (editing && draft.kind === 'segment' && rows.length > 0)) && <section className="card crm-table-card">
          {!editing && canOutreach && <div className="list-action-bar"><span>{selected.size} selected</span><div className="preview-actions"><button className="btn" disabled={disabled || !selected.size || selected.size > 25} onClick={() => prepare('whatsapp')}>Draft WhatsApp</button><button className="btn primary" disabled={disabled || !selected.size || selected.size > 25} onClick={() => prepare('email')}>Create sequence</button></div>{selected.size > 25 && <p className="hint">Choose up to 25 businesses per campaign.</p>}</div>}
          {editing && <p className="crm-result-count">{total.toLocaleString()} matches{total > rows.length ? ` · First ${rows.length}` : ''}</p>}
          <div className="crm-table-scroll"><table className="crm-table"><thead><tr>{!editing && canOutreach && <th><input aria-label="Select this page" type="checkbox" disabled={disabled || !rows.length} checked={rows.length > 0 && rows.every(row => selected.has(row.place_id))} onChange={event => { setSelected(event.target.checked ? new Set(rows.map(row => row.place_id)) : new Set()); setHandoff(null); setExclusions([]); }} /></th>}<th>Business</th><th>Email</th><th>Phone</th><th>Score</th></tr></thead><tbody>{rows.map(row => <tr key={row.place_id}>{!editing && canOutreach && <td><input type="checkbox" disabled={disabled} aria-label={`Select ${row.name}`} checked={selected.has(row.place_id)} onChange={() => toggle(row.place_id)} /></td>}<td><button className="crm-record-link" onClick={() => onOpenLead?.(row.place_id)}>{row.name}</button><small>{row.category}</small></td><td>{row.emails?.[0] || '—'}</td><td>{row.whatsapp || row.phone_e164 || '—'}</td><td>{row.score ?? '-'}</td></tr>)}</tbody></table></div>
          {!rows.length && <p className="crm-empty">No matching businesses</p>}
          {!editing && (page > 0 || (page + 1) * 100 < total) && <div className="crm-pagination"><IconButton icon="previous" label="Previous page" disabled={disabled || page === 0} onClick={() => open(detail.id, page - 1)}/><span>Page {page + 1}</span><IconButton icon="next" label="Next page" disabled={disabled || (page + 1) * 100 >= total} onClick={() => open(detail.id, page + 1)}/></div>}
        </section>}
      </section>
    </div>
  </div>;
}
