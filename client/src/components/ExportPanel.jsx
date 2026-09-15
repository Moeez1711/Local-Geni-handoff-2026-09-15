import { useEffect, useRef, useState } from 'react';
import { api, download, fmt, leadParams } from '../lib/api.js';
import { Icon, PageHead } from './ui.jsx';

const PRESETS = {
  contact: { label: 'Call & contact list', hint: 'Phone, email, WhatsApp and notes', ids: [2, 3, 4, 5, 7, 8, 16, 20, 21, 22] },
  crm: { label: 'CRM import', hint: 'Business details and outreach status', ids: [2, 3, 4, 7, 8, 16, 20, 21, 22, 23, 25] },
  full: { label: 'Complete record', hint: 'Every available standard and custom field' },
};

export default function ExportPanel({ scanId, filters, selected, notify, onOpenLeads, onBusyChange }) {
  const [scope, setScope] = useState(selected.size ? 'selected' : 'filtered'), [format, setFormat] = useState('xlsx');
  const [allColumns, setAllColumns] = useState([]), [columns, setColumns] = useState([]), [preset, setPreset] = useState('contact');
  const [preview, setPreview] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [columnQuery, setColumnQuery] = useState(''), [expanded, setExpanded] = useState(false), [sort, setSort] = useState('score');
  const lock = useRef(false);
  const sid = filters.scope === 'scan' ? scanId : '';
  const scopePayload = { selected: { ids: [...selected] }, filtered: { filters: leadParams(filters, scanId) },
    qualified: { filters: { scanId: sid, tier: 'hot,potential' } }, uncontacted: { filters: { scanId: sid, tier: 'hot,potential', leadStatus: 'not_contacted' } }, all: { filters: { scanId: sid } } }[scope];
  const payload = { ...scopePayload, filters: { ...(scopePayload.filters || {}), sort, dir: sort === 'name' ? 'asc' : 'desc' }, columns };
  const payloadKey = JSON.stringify(payload);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  function applyPreset(key, available = allColumns) { setPreset(key); setColumns(key === 'full' ? available.map(row => row.id) : PRESETS[key].ids.map(index => `lead:${index}`)); }
  useEffect(() => {
    const controller = new AbortController();
    api.get('/export/columns', { signal: controller.signal }).then(data => { setAllColumns(data.columns); applyPreset('contact', data.columns); }).catch(err => { if (!controller.signal.aborted) { setError(err.message); setLoading(false); } });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!allColumns.length) return;
    if (!columns.length) { setPreview(null); setLoading(false); return; }
    const controller = new AbortController(); setLoading(true); setError(''); setPreview(null);
    api.post('/export/preview', payload, { signal: controller.signal }).then(setPreview).catch(err => { if (!controller.signal.aborted) setError(err.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [payloadKey, allColumns.length]);
  function toggle(id) { setPreset('custom'); setColumns(current => current.includes(id) ? current.filter(value => value !== id) : allColumns.filter(row => current.includes(row.id) || row.id === id).map(row => row.id)); }
  async function run() {
    if (lock.current || !preview?.exportCount || loading || !columns.length) return;
    lock.current = true; setBusy(true);
    try { await download(format, payload); notify('Export file ready', 'success'); }
    catch (err) { setError(err.message); }
    finally { lock.current = false; setBusy(false); }
  }
  const options = [['selected', `Selected businesses (${selected.size})`], ['filtered', 'Current Lead Results filters'], ['uncontacted', 'Ready to contact'], ['qualified', 'All qualified leads'], ['all', 'All businesses']];
  const fieldGroups = Object.entries(Object.groupBy(allColumns.filter(row => row.label.toLowerCase().includes(columnQuery.toLowerCase())), row => row.group));
  return <div className="page export-page export-builder"><PageHead title="Export leads" description="Prepare a contact list, import into another CRM, or keep a complete record."><button className="btn primary" disabled={busy || loading || !preview?.exportCount || !columns.length} onClick={run}><Icon name="download" size={16}/>{busy ? 'Preparing file…' : `Export ${preview ? fmt.num(preview.exportCount) : ''} ${format === 'xlsx' ? 'to Excel' : 'as CSV'}`}</button></PageHead>
    {error && <p className="banner error" role="alert">{error}</p>}
    <div className="export-builder-layout">
      <section className="card export-options"><header><Icon name="leads" size={19}/><h3>Choose your data</h3></header>
        <fieldset disabled={busy} className="form"><label className="field"><span>Businesses</span><select value={scope} onChange={event => setScope(event.target.value)}>{options.map(([id, label]) => <option key={id} value={id} disabled={id === 'selected' && !selected.size}>{label}</option>)}</select></label>
          <p className="hint export-scope-note">{scope === 'selected' ? 'Only the businesses you selected in Leads.' : scope === 'filtered' ? 'Matches your current filters, across all result pages.' : scope === 'uncontacted' ? 'Hot and potential leads you have not contacted.' : scope === 'qualified' ? 'All hot and potential leads.' : 'Permanently closed businesses are excluded.'}<br/>{scope !== 'selected' && (sid ? `Scan #${sid}` : 'Across all scans')}{onOpenLeads && <button type="button" className="link" onClick={onOpenLeads}>Review in Leads <Icon name="arrowUpRight" size={12}/></button>}</p>
          <label className="field"><span>Column preset</span><select value={preset} onChange={event => applyPreset(event.target.value)}>{Object.entries(PRESETS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}{preset === 'custom' && <option value="custom">Custom selection</option>}</select></label>
          <small className="hint">{PRESETS[preset]?.hint || `${columns.length} fields selected`}</small>
          <label className="field"><span>Sort businesses</span><select value={sort} onChange={event => setSort(event.target.value)}><option value="score">Highest score first</option><option value="name">Business name A–Z</option><option value="recent">Newest first</option></select></label>
          <div className="export-format"><span>File format</span><div className="seg"><button type="button" aria-pressed={format === 'xlsx'} className={format === 'xlsx' ? 'on' : ''} onClick={() => setFormat('xlsx')}><Icon name="spreadsheet" size={15}/>Excel</button><button type="button" aria-pressed={format === 'csv'} className={format === 'csv' ? 'on' : ''} onClick={() => setFormat('csv')}><Icon name="list" size={15}/>CSV</button></div></div>
          <small className="hint">{format === 'xlsx' ? 'A formatted workbook with filters and a frozen header.' : 'UTF-8 CSV for spreadsheets and CRM imports.'}</small>
        </fieldset>
        <footer><small>{preview?.total > 5000 ? `First 5,000 of ${fmt.num(preview.total)} matches. Narrow your filters to export a smaller set.` : 'Up to 5,000 businesses per file'}</small></footer>
      </section>
      <div className="export-preview-column">
        <section className="card export-data-preview"><header><div><h3><Icon name="eye" size={18}/>File preview</h3><p>{loading ? 'Updating preview…' : preview ? `${fmt.num(preview.total)} matching businesses · ${columns.length} columns` : 'Select at least one column'}</p></div><span className="export-file-type">.{format}</span></header>
          {preview?.rows.length ? <><div className="export-preview-scroll" tabIndex={0} role="region" aria-label="Export data preview"><table><thead><tr>{preview.columns.map(column => <th key={column.id}>{column.label}</th>)}</tr></thead><tbody>{preview.rows.map((row, index) => <tr key={index}>{row.map((value, column) => <td key={column} title={String(value)}>{String(value) || <span className="muted">—</span>}</td>)}</tr>)}</tbody></table></div><p className="export-preview-note">First {preview.rows.length} rows shown. The file includes {fmt.num(preview.exportCount)} businesses.</p></> : <div className="export-preview-empty"><Icon name={loading ? 'loading' : 'search'} size={24}/><strong>{loading ? 'Preparing preview' : !columns.length ? 'Choose the fields you need' : 'No businesses match'}</strong><span>{!loading && columns.length > 0 ? 'Change the selection or update your filters in Leads.' : 'Your selected fields will appear here.'}</span></div>}
        </section>
        <section className="card export-column-picker"><header><div><h3><Icon name="settings" size={18}/>Columns</h3><p>{columns.length} of {allColumns.length} selected</p></div><button className="btn" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Done' : 'Customize'}</button></header>
          {expanded ? <><div className="export-column-tools"><input type="search" aria-label="Find export column" placeholder="Find a column" value={columnQuery} onChange={event => setColumnQuery(event.target.value)}/><button className="link" disabled={busy} onClick={() => applyPreset('full')}>Select all</button><button className="link" disabled={busy} onClick={() => { setPreset('custom'); setColumns([]); }}>Clear</button></div><fieldset disabled={busy} className="export-column-groups"><legend className="sr-only">Export columns</legend>{fieldGroups.map(([group, rows]) => <div key={group}><h4>{group}</h4>{rows.map(row => <label key={row.id}><input type="checkbox" checked={columns.includes(row.id)} onChange={() => toggle(row.id)}/><span>{row.label}</span></label>)}</div>)}{!fieldGroups.length && <p className="hint">No matching fields.</p>}</fieldset></> : <div className="export-selected-columns">{columns.map(id => <span key={id}>{allColumns.find(row => row.id === id)?.label}</span>)}</div>}
        </section>
      </div>
    </div>
  </div>;
}
