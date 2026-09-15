import { useEffect, useState } from 'react';
import { api, fmt, LEAD_STATUSES, leadParams, PAGE_SIZE, qs, webBadge, DEFAULT_FILTERS } from '../lib/api.js';
import { Empty, FilterTabs, Icon, PageHead, TierPill } from './ui.jsx';
import { isDue, messageFor, shortDate } from '../lib/outreach.js';
import { WHATSAPP_BATCH_LIMIT } from '../lib/whatsappBatch.js';
import { FinishedPagesExportButton } from './FinishedPageFiles.jsx';
import ProviderIcon from './ProviderIcon.jsx';
import '../integrations.css';

const TIERS = [['hot', 'Hot'], ['potential', 'Potential'], ['low', 'Low']];
const WEB = [['none', 'No website'], ['social_only', 'Social only'], ['broken', 'Broken'], ['outdated', 'Outdated'],
  ['not_mobile', 'Not mobile'], ['no_https', 'No HTTPS'], ['modern', 'Modern'], ['pending', 'Unchecked']];

const topReasons = (r, n = 2) => r.reasons.filter((x) => x.points > 0).sort((a, b) => b.points - a.points).slice(0, n).map((x) => x.label);
const shortAddr = (a) => (a || '').split(',').slice(0, 2).join(',');
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (code) => { try { return regionNames.of(code); } catch { return code; } };
// Keeps a selected tab visible even when current filters leave it with no leads.
const withSelected = (tabs, value, make) => (value && !tabs.some((t) => t.value === value) ? [...tabs, make(value)] : tabs);
const SECONDARY_FILTERS = ['minRating', 'minReviews', 'category', 'leadStatus', 'contact', 'followUp'];
const RatingStars = ({ value }) => {
  const rating = Number(value);
  if (!Number.isFinite(rating) || rating <= 0) return <span className="muted">—</span>;
  const bounded = Math.min(5, Math.max(0, rating));
  const rounded = Math.round(bounded * 2) / 2;
  const full = Math.floor(rounded);
  const half = rounded - full === 0.5;
  return <span className="rating-stars" title={`${rating} out of 5`} role="img" aria-label={`${rating} out of 5 stars`}>
    {Array.from({ length: 5 }, (_, index) => <span aria-hidden="true" className={`rating-star ${index < full ? 'full' : index === full && half ? 'half' : 'empty'}`} key={index}>★</span>)}
  </span>;
};
const SortTh = ({ k, sort, dir, onSort, children, className = '' }) => (
  <th scope="col" className={`sortable ${className} ${sort === k ? 'sorted' : ''}`} aria-sort={sort === k ? (dir === 'desc' ? 'descending' : 'ascending') : 'none'}>
    <button type="button" className="sort-button" onClick={() => onSort(k)} aria-label={`Sort by ${children}, ${sort === k && dir === 'desc' ? 'ascending' : 'descending'}`}>
      {children}{sort === k && <Icon name={dir === 'desc' ? 'arrowDown' : 'arrowUp'} size={13} />}
    </button>
  </th>
);

export default function LeadResults({ scanId, filters, setFilters, selected, setSelected, leadsVersion, onOpenLead, onComposeEmail, onComposeWhatsApp, onComposeSms, onExport, onShortlist, onCreateCrm, onDeleted, notify, settings, onOrder, followUps }) {
  const [data, setData] = useState({ total: 0, rows: [] });
  const [top, setTop] = useState([]);
  const [cats, setCats] = useState([]);
  const [countries, setCountries] = useState([]);
  const [searchCats, setSearchCats] = useState({ total: 0, rows: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false), [retry, setRetry] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState(filters.q);
  const [filtersOpen, setFiltersOpen] = useState(() => filters.web.length > 0 || SECONDARY_FILTERS.some((k) => filters[k]));
  const [crmMode, setCrmMode] = useState('');
  const [crmBusy, setCrmBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === search ? f : { ...f, q: search, page: 0 })), 300);
    return () => clearTimeout(t);
  }, [search, setFilters]);

  const params = leadParams(filters, scanId);
  const effectiveScope = scanId ? filters.scope : 'all';
  const key = `${JSON.stringify(params)}|${filters.page}`;
  const countryKey = JSON.stringify({ ...params, country: '' });

  useEffect(() => {
    const ctl = new AbortController();
    api.get(`/leads/countries${qs({ ...params, country: '' })}`, { signal: ctl.signal }).then(setCountries).catch(() => {});
    return () => ctl.abort();
  }, [countryKey, leadsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const searchCatKey = JSON.stringify({ ...params, searchCategory: '' });
  useEffect(() => {
    const ctl = new AbortController();
    api.get(`/leads/search-categories${qs({ ...params, searchCategory: '' })}`, { signal: ctl.signal }).then(setSearchCats).catch(() => {});
    return () => ctl.abort();
  }, [searchCatKey, leadsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true); setLoadError(false);
    api.get(`/leads${qs({ ...params, limit: PAGE_SIZE, offset: filters.page * PAGE_SIZE })}`, { signal: ctl.signal })
      .then((d) => { if (ctl.signal.aborted) return; setData(d); setLoading(false); onOrder(d.rows.map((r) => r.place_id)); })
      .catch((e) => { if (!ctl.signal.aborted) { setLoadError(true); setLoading(false); setData({ total: 0, rows: [] }); onOrder([]); } });
    return () => ctl.abort();
  }, [key, leadsVersion, retry]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const sid = filters.scope === 'scan' ? scanId : '';
    const scoped = { scanId: sid, country: filters.country, searchCategory: filters.searchCategory, trash: filters.trash };
    api.get(`/leads${qs({ ...scoped, tier: 'hot', leadStatus: 'not_contacted', limit: 4 })}`).then((d) => setTop(d.rows)).catch(() => {});
    api.get(`/leads/categories${qs(scoped)}`).then(setCats).catch(() => {});
  }, [filters.scope, filters.country, filters.searchCategory, filters.trash, scanId, leadsVersion]);

  const patch = (p) => setFilters((f) => ({ ...f, ...p, page: 0 }));
  const toggle = (k, val) => patch({ [k]: filters[k].includes(val) ? filters[k].filter((x) => x !== val) : [...filters[k], val] });
  const sortBy = (k) => patch({ sort: k, dir: filters.sort === k && filters.dir === 'desc' ? 'asc' : 'desc' });
  const allOnPage = data.rows.length > 0 && data.rows.every((r) => selected.has(r.place_id));
  const toggleRow = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const togglePage = () => setSelected((s) => {
    const n = new Set(s);
    for (const r of data.rows) { if (allOnPage) n.delete(r.place_id); else n.add(r.place_id); }
    return n;
  });

  const applyStatus = (ids, lead_status) => setData((d) => ({ ...d, rows: d.rows.map((r) => (ids.has(r.place_id) ? { ...r, lead_status } : r)) }));
  async function setStatus(id, lead_status) {
    try { await api.patch(`/leads/${id}`, { lead_status }); applyStatus(new Set([id]), lead_status); }
    catch (e) { notify(e.message, 'error'); }
  }
  async function bulkStatus(lead_status) {
    try {
      await Promise.all([...selected].map((id) => api.patch(`/leads/${id}`, { lead_status })));
      applyStatus(selected, lead_status);
      notify(`${selected.size} leads marked ${lead_status.replace('_', ' ')}`, 'success');
    } catch (e) { notify(e.message, 'error'); }
  }
  async function remove(ids, name) {
    if (deleting) return;
    if (!filters.trash && !window.confirm(`Move ${name || `${ids.length} selected lead${ids.length===1?'':'s'}`} to Trash? Scheduled outreach will stop. You can restore these leads later. Previously shared links remain active.`)) return;
    setDeleting(true);
    try {
      const result = await api.post(filters.trash ? '/leads/restore' : '/leads/delete', { ids, confirmed: true });
      setSelected(new Set());
      setFilters(f => ({ ...f, page: Math.max(0, Math.min(f.page, Math.ceil(Math.max(0, data.total-result.count)/PAGE_SIZE)-1)) }));
      onDeleted?.(ids);
      notify(`${result.count} lead${result.count===1?'':'s'} ${filters.trash?'restored':'moved to Trash'}`, 'success');
    } catch (e) { notify(e.message,'error'); }
    finally { setDeleting(false); }
  }
  async function confirmCrmImport() {
    if (!onCreateCrm || crmBusy || !crmMode) return;
    setCrmBusy(true);
    try { await onCreateCrm([...selected], crmMode); setCrmMode(''); }
    catch (error) { notify(error.message, 'error'); }
    finally { setCrmBusy(false); }
  }

  useEffect(() => {
    if (!crmMode) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape' && !crmBusy) {
        event.preventDefault();
        setCrmMode('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [crmMode, crmBusy]);

  const stop = (e) => e.stopPropagation();
  const from = data.total ? filters.page * PAGE_SIZE + 1 : 0;
  const to = Math.min(data.total, (filters.page + 1) * PAGE_SIZE);
  const secondaryCount = Number(filters.web.length > 0) + SECONDARY_FILTERS.filter((k) => filters[k]).length;
  const hasFilters = Boolean(search || filters.tier.length || secondaryCount || filters.country || filters.searchCategory);
  const resetFilters = () => { setSearch(''); setFilters({ ...DEFAULT_FILTERS, scope: filters.scope, trash: filters.trash }); };
  const sortProps = { sort: filters.sort, dir: filters.dir, onSort: sortBy };

  return (
    <div className="page leads-page">
      <PageHead eyebrow="YOUR WORKSPACE" title={filters.trash ? 'Deleted leads' : 'Leads'}>
        {!filters.trash && <button className="btn" onClick={onExport}><Icon name="download" size={15}/>Export{selected.size ? ` (${selected.size})` : ''}</button>}
        <button className="ci" title={filters.trash?'Back to leads':'Trash'} aria-label={filters.trash?'Back to leads':'Trash'} onClick={() => { setSelected(new Set()); setSearch(''); setFilters({ ...DEFAULT_FILTERS, scope:'all', trash:!filters.trash }); }}><Icon name={filters.trash?'previous':'trash'} size={17}/></button>
        <div className="seg" role="group" aria-label="Lead source">
          <button className={effectiveScope === 'scan' ? 'on' : ''} aria-pressed={effectiveScope === 'scan'} disabled={!scanId} onClick={() => patch({ scope: 'scan' })}>This scan</button>
          <button className={effectiveScope === 'all' ? 'on' : ''} aria-pressed={effectiveScope === 'all'} onClick={() => patch({ scope: 'all' })}>All scans</button>
        </div>
      </PageHead>
      {filters.trash && <p className="results-intro muted">Restoring a lead does not restart stopped outreach.</p>}

      {(countries.length > 0 || filters.country) && (
        <FilterTabs ariaLabel="Filter leads by country" value={filters.country} onChange={(v) => patch({ country: v })}
          tabs={withSelected([
            { value: '', label: 'All countries', n: countries.reduce((sum, c) => sum + c.n, 0) },
            ...countries.map((c) => ({ value: c.k, label: countryName(c.k), n: c.n })),
          ], filters.country, (v) => ({ value: v, label: countryName(v), n: 0 }))} />
      )}

      {(searchCats.rows.length > 0 || filters.searchCategory) && (
        <div className="searched-filter-row">
          <span className="searched-filter-label"><Icon name="search" size={14}/>Searched for</span>
          <FilterTabs className="searched-filter-tabs" variant="pill" ariaLabel="Filter leads by searched category" value={filters.searchCategory} onChange={(v) => patch({ searchCategory: v })}
            tabs={withSelected([
              { value: '', label: 'All', n: searchCats.total },
              ...searchCats.rows.filter((c) => c.n > 0).map((c) => ({ value: c.k, label: c.k, n: c.n })),
            ], filters.searchCategory, (v) => ({ value: v, label: v, n: 0 }))} />
        </div>
      )}

      {!filters.trash && followUps.due > 0 && filters.followUp !== 'due' && (
        <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-hot/30 bg-hot-soft px-4 py-2.5 text-hot-ink">
          <b>{followUps.due} follow-up{followUps.due === 1 ? '' : 's'} due today</b>
          {followUps.upcoming > 0 && <span className="text-xs">{followUps.upcoming} more scheduled later</span>}
          <button className="btn xs ml-auto" onClick={() => { setSearch(''); setFilters({ ...DEFAULT_FILTERS, scope: 'all', followUp: 'due', sort: 'followup', dir: 'asc' }); }}>Show them</button>
        </div>
      )}

      {!filters.trash && top.length > 0 && (
        <section className="lead-recommendations" aria-labelledby="contact-first-heading">
          <div className="results-section-head">
            <div><h2 id="contact-first-heading" className="results-section-title"><Icon name="sparkles" size={15}/>Start with these<span>{top.length}</span></h2></div>
            <span className="recommendation-caption">Priority leads · Not contacted</span>
          </div>
          <div className={`first-up${top.length === 1 ? ' single' : ''}`}>
          {top.map((r, i) => (
            <article key={r.place_id} className="first-card" onClick={() => onOpenLead(r.place_id)}>
              <div className="first-rank">#{i + 1}</div>
              <div className="first-body">
                <strong><button type="button" className="lead-open" onClick={(e) => { e.stopPropagation(); onOpenLead(r.place_id); }} aria-label={`View details for ${r.name}`}>{r.name}</button></strong>
                <small className="muted">{r.category} · {r.rating == null ? 'Unrated' : `${r.rating} / 5`} · {fmt.num(r.review_count)} reviews</small>
                {topReasons(r, 2).length > 0 && <ul>{topReasons(r, 2).map((t) => <li key={t}>{t}</li>)}</ul>}
              </div>
              <div className="first-side" onClick={stop}>
                <span className="score-big num" title="Priority score">{r.score}<small>score</small></span>
                <div className="contact-icons first-contact-actions">
                  {(r.whatsapp || r.phone_e164) && onComposeWhatsApp && <button type="button" className={`ci wa ${r.whatsapp_source === 'website' ? 'verified' : ''}`} onClick={() => onComposeWhatsApp([r.place_id])} aria-label={`Open WhatsApp composer for ${r.name}`} title={r.whatsapp_source === 'website' ? 'Open WhatsApp composer · published link' : 'Open WhatsApp composer · number not verified'}><ProviderIcon provider="whatsapp" size={19} /></button>}
                  {r.phone_e164 && <a className="ci" href={`tel:${r.phone_e164}`} aria-label={`Call ${r.name}`} title={`Call ${r.phone_intl || r.phone_e164}`}><Icon name="phone" size={17} /></a>}
                  {r.phone_e164 && onComposeSms && <button type="button" className="ci sms" onClick={() => onComposeSms(r)} aria-label={`Open SMS composer for ${r.name}`} title="Send SMS from Local Geni"><Icon name="sms" size={17} /></button>}
                  {r.website && <a className="ci website" href={r.website} target="_blank" rel="noreferrer" aria-label={`Visit ${r.name} website`} title="Visit website"><Icon name="globe" size={17} /></a>}
                </div>
              </div>
            </article>
          ))}
          </div>
        </section>
      )}

      <section className="card filters" aria-label="Filter leads">
        <div className="filter-toolbar">
          <label className="search-field"><span className="sr-only">Search leads by name, phone, address, website or notes</span><Icon name="search" size={15}/><input type="search" className="search" placeholder="Search leads…" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
          <div className="filter-actions">
            <button type="button" className={`btn ${filtersOpen || secondaryCount ? 'secondary' : 'ghost'}`} title="More filters" aria-label={secondaryCount ? `More filters, ${secondaryCount} active` : 'More filters'} aria-expanded={filtersOpen} aria-controls="lead-more-filters" onClick={() => setFiltersOpen((open) => !open)}><Icon name="settings" size={15}/>Filters{secondaryCount > 0 && <span className="filter-count">{secondaryCount}</span>}<Icon name={filtersOpen ? 'arrowUp' : 'arrowDown'} size={12}/></button>
          </div>
        </div>
        <div className="chip-group" role="group" aria-label="Filter by priority">
          <span className="filter-label">Priority</span>
          {TIERS.map(([k, l]) => <button key={k} className={`chip-btn ${filters.tier.includes(k) ? 'on' : ''}`} aria-pressed={filters.tier.includes(k)} onClick={() => toggle('tier', k)}>{l}</button>)}
        </div>
        {hasFilters && <button type="button" className="btn ghost lead-filter-reset" onClick={resetFilters}><Icon name="close" size={13}/>Clear filters</button>}
        <div id="lead-more-filters" className="filter-panel" hidden={!filtersOpen}>
        <div className="chip-group" role="group" aria-label="Filter by website quality">
          <span className="filter-label">Website</span>
          {WEB.map(([k, l]) => <button key={k} className={`chip-btn ${filters.web.includes(k) ? 'on' : ''}`} aria-pressed={filters.web.includes(k)} onClick={() => toggle('web', k)}>{l}</button>)}
        </div>
        <div className="filter-selects">
          <label className="filter-field"><span>Minimum rating</span>
          <select value={filters.minRating} onChange={(e) => patch({ minRating: e.target.value })}>
            <option value="">Any rating</option><option value="3.5">3.5 and above</option><option value="4">4.0 and above</option><option value="4.5">4.5 and above</option>
          </select></label>
          <label className="filter-field"><span>Review count</span>
          <select value={filters.minReviews} onChange={(e) => patch({ minReviews: e.target.value })}>
            <option value="">Any reviews</option><option value="10">10+ reviews</option><option value="50">50+</option><option value="100">100+</option><option value="500">500+</option>
          </select></label>
          <label className="filter-field"><span>Business type</span>
          <select value={filters.category} onChange={(e) => patch({ category: e.target.value })}>
            <option value="">All Google types</option>
            {cats.map((c) => <option key={c.k} value={c.k}>{c.k} ({c.n})</option>)}
          </select></label>
          <label className="filter-field"><span>Contact status</span>
          <select value={filters.leadStatus} onChange={(e) => patch({ leadStatus: e.target.value })}>
            <option value="">Any status</option>
            {LEAD_STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select></label>
          <label className="filter-field"><span>Contact method</span>
          <select value={filters.contact} onChange={(e) => patch({ contact: e.target.value })}>
            <option value="">Any contact</option><option value="whatsapp">Has WhatsApp</option><option value="phone">Has phone</option><option value="email">Has email</option>
          </select></label>
          <label className="filter-field"><span>Follow-up</span>
          <select value={filters.followUp} onChange={(e) => patch(e.target.value ? { followUp: e.target.value, sort: 'followup', dir: 'asc' } : { followUp: '', sort: 'score', dir: 'desc' })}>
            <option value="">Any follow-up</option><option value="due">Follow-up due</option><option value="scheduled">Follow-up scheduled</option>
          </select></label>
        </div>
        </div>
      </section>

      {selected.size > 0 && (
        <div className="bulkbar" role="region" aria-label="Selected businesses">
          <div className="bulkbar-summary"><b role="status">{selected.size} {selected.size === 1 ? 'business' : 'businesses'} selected</b>{selected.size > data.rows.filter(row => selected.has(row.place_id)).length && <small>{selected.size - data.rows.filter(row => selected.has(row.place_id)).length} outside this page</small>}<small>Choose what to do next</small></div>
          {!filters.trash && <div className="bulkbar-actions"><div className="bulkbar-primary">{onShortlist && <button className="btn xs primary" onClick={() => onShortlist([...selected])}><Icon name="list" size={15}/>Save as list</button>}{onCreateCrm && <><button className="btn xs" onClick={() => setCrmMode('companies')}><Icon name="building" size={15}/>Add to CRM</button><button className="btn xs" onClick={() => setCrmMode('contacts')}><Icon name="person" size={15}/>Create contacts</button></>}{onComposeWhatsApp && <button className="btn xs" disabled={deleting || selected.size > WHATSAPP_BATCH_LIMIT} title={selected.size > WHATSAPP_BATCH_LIMIT ? `Select up to ${WHATSAPP_BATCH_LIMIT} businesses for a WhatsApp batch` : 'Review personal messages and open one WhatsApp chat at a time'} onClick={() => onComposeWhatsApp([...selected])}>WhatsApp batch{selected.size > WHATSAPP_BATCH_LIMIT ? ` / maximum ${WHATSAPP_BATCH_LIMIT}` : ''}</button>}<button className="btn xs" onClick={() => bulkStatus('contacted')}>Mark contacted</button><button className="btn xs" onClick={() => bulkStatus('interested')}>Mark interested</button><FinishedPagesExportButton ids={selected} notify={notify} /></div><button className="btn xs ghost" onClick={() => setSelected(new Set())}>Clear selection</button></div>}
          <button className={`btn xs ${filters.trash?'':'danger'}`} disabled={deleting} onClick={() => remove([...selected])}>{deleting?'Working...':filters.trash?'Restore selected':'Delete selected'}</button>
        </div>
      )}

      {crmMode && (
        <div className="lead-action-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !crmBusy) setCrmMode(''); }}>
          <section className="lead-action-dialog" role="dialog" aria-modal="true" aria-labelledby="lead-action-title" onMouseDown={event => event.stopPropagation()}>
            <header><div><p className="eyebrow">{selected.size} selected {selected.size === 1 ? 'business' : 'businesses'}</p><h2 id="lead-action-title">{crmMode === 'contacts' ? 'Create contacts' : 'Add to CRM'}</h2></div><button type="button" className="icon-btn" aria-label="Close" disabled={crmBusy} onClick={() => setCrmMode('')}><Icon name="close" size={18}/></button></header>
            <div className="lead-action-body">{crmMode === 'contacts' ? <><p>Create one contact record for each selected business that has a phone number or email.</p><div className="lead-action-callout"><Icon name="info" size={17}/><span>The contact name starts as the business name. No person is guessed. You can edit the record in Contacts later. Businesses without contact details are skipped.</span></div></> : <><p>Add the selected businesses to your CRM so they can be assigned, tracked, and connected to deals.</p><div className="lead-action-callout"><Icon name="building" size={17}/><span>One company record is created per business. Existing CRM companies are kept and counted once.</span></div></>}</div>
            <footer><button type="button" className="btn" disabled={crmBusy} onClick={() => setCrmMode('')}>Cancel</button><button type="button" className="btn primary" disabled={crmBusy} onClick={confirmCrmImport}>{crmBusy ? 'Working…' : crmMode === 'contacts' ? 'Create contacts' : 'Add companies'}</button></footer>
          </section>
        </div>
      )}

      <section className="card flush" aria-label="Lead results" aria-busy={loading}>
        <div className="results-toolbar"><h2 className="results-section-title">{hasFilters ? 'Matching businesses' : 'Your businesses'}</h2><span className="muted small" role="status">{loading ? 'Updating results...' : loadError ? 'Results unavailable' : `${fmt.num(data.total)} ${data.total === 1 ? 'lead' : 'leads'}`}</span></div>
        {loadError && <div className="results-retry" role="alert"><Icon name="alert" size={20}/><div><strong>We couldn’t load your businesses</strong><p>Your filters and selection are still here. Check your connection and try again.</p></div><button className="btn" onClick={() => setRetry(value => value + 1)}><Icon name="refresh" size={15}/>Try again</button></div>}
        <div className="table-wrap">
          <table className={`table leads ${loading ? 'is-loading' : ''}`}>
            <caption className="sr-only">Business leads. Select a business name to see details. Column header buttons change the sort order.</caption>
            <thead>
              <tr>
                <th scope="col" className="check"><input type="checkbox" checked={allOnPage} ref={(el) => { if (el) el.indeterminate = !allOnPage && data.rows.some((r) => selected.has(r.place_id)); }} onChange={togglePage} aria-label="Select all leads on this page" /></th>
                <SortTh k="score" {...sortProps}>Priority</SortTh>
                <SortTh k="name" {...sortProps}>Business</SortTh>
                <th scope="col">Web presence</th>
                <SortTh k="rating" className="r" {...sortProps}>Rating</SortTh>
                <SortTh k="reviews" className="r" {...sortProps}>Reviews</SortTh>
                <th scope="col">Contact</th>
                <th scope="col">Why</th>
                <th scope="col">Status</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const [webLabel, webTone] = webBadge(r);
                return (
                  <tr key={r.place_id} className={`row t-${r.tier} ${selected.has(r.place_id) ? 'selected' : ''}`} onClick={() => !filters.trash && onOpenLead(r.place_id)}>
                    <td className="check" onClick={stop}><input type="checkbox" checked={selected.has(r.place_id)} onChange={() => toggleRow(r.place_id)} aria-label={`Select ${r.name}`} /></td>
                    <td className="prio">
                      <div className="score"><span className={`score-num ${r.tier}`}>{r.score}</span><span className="score-bar"><i className={r.tier} style={{ width: `${r.score}%` }} /></span></div>
                    </td>
                    <td className="biz"><strong>{filters.trash?r.name:<button type="button" className="lead-open" onClick={(e) => { e.stopPropagation(); onOpenLead(r.place_id); }} aria-label={`View details for ${r.name}`}>{r.name}</button>}</strong><small>{[r.category,shortAddr(r.address)].filter(Boolean).join(' · ')}</small>
                    </td>
                    <td><span className={`badge ${webTone}`}>{webLabel}</span></td>
                    <td className="r"><RatingStars value={r.rating} /></td>
                    <td className="r num">{fmt.num(r.review_count)}</td>
                    <td onClick={stop}>
                      <div className="contact-icons" inert={filters.trash || undefined}>
                        {(r.whatsapp || r.phone_e164) && onComposeWhatsApp && <button type="button" className={`ci wa ${r.whatsapp_source === 'website' ? 'verified' : ''}`} aria-label={`Open WhatsApp composer for ${r.name}`} onClick={() => onComposeWhatsApp([r.place_id])} title={r.whatsapp_source === 'website' ? 'Open WhatsApp composer · published link' : 'Open WhatsApp composer · number not verified'}><ProviderIcon provider="whatsapp" size={19} /></button>}
                        {r.phone_e164 && <a className="ci" aria-label={`Call ${r.name}`} href={`tel:${r.phone_e164}`} title={`Call ${r.phone_intl || r.phone_e164}`}><Icon name="phone" size={17} /></a>}
                        {r.phone_e164 && onComposeSms && <button type="button" className="ci sms" aria-label={`Open SMS composer for ${r.name}`} onClick={() => onComposeSms(r)} title="Send SMS from Local Geni"><Icon name="sms" size={17} /></button>}
                        {r.website && <a className="ci website" aria-label={`Visit ${r.name} website`} href={r.website} target="_blank" rel="noreferrer" title="Visit website"><Icon name="globe" size={17} /></a>}
                        {r.emails.length > 0 && onComposeEmail && <button className="ci" aria-label={`Compose email for ${r.name}`} onClick={() => onComposeEmail(r, messageFor(r, settings))} title={`Email ${r.emails[0]}`}><Icon name="mail" size={17} /></button>}
                      </div>
                    </td>
                    <td className="why"><span>{topReasons(r).join(' / ')}</span></td>
                    <td onClick={stop}>
                      <span className={`lead-status-control s-${r.lead_status}`}><Icon name={({contacted:'check',interested:'sparkles',converted:'shield',not_interested:'close'})[r.lead_status] || 'person'} size={13}/><select disabled={filters.trash} className="status" aria-label={`Contact status for ${r.name}`} value={r.lead_status} onChange={(e) => setStatus(r.place_id, e.target.value)}>
                        {LEAD_STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select><Icon name="next" size={12}/></span>
                      {r.follow_up_at && r.lead_status !== 'converted' && r.lead_status !== 'not_interested' && (
                        <div className={`mt-1 text-[11px] ${isDue(r.follow_up_at) ? 'font-semibold text-hot' : 'text-muted'}`}>Follow up {shortDate(r.follow_up_at)}</div>
                      )}
                    </td>
                    <td onClick={stop}><button className="ci" title={filters.trash?'Restore lead':'Move to Trash'} disabled={deleting} onClick={() => remove([r.place_id], r.name)} aria-label={`${filters.trash?'Restore':'Delete'} ${r.name}`}><Icon name={filters.trash?'restore':'trash'} size={16}/></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!loading && !loadError && !data.rows.length && (
            <Empty title={hasFilters ? 'No businesses match these filters' : filters.trash ? 'Trash is empty' : 'Your next connection starts here'}>
              <p>{hasFilters ? 'Try a broader search or clear your filters to see more businesses.' : filters.trash ? 'Leads you delete will appear here. You can restore them at any time.' : 'Start a search in Find businesses. Discovered businesses will appear here.'}</p>
              {hasFilters && <button className="btn" onClick={resetFilters}>Clear filters</button>}
              {effectiveScope === 'scan' && <button className="btn ghost" onClick={() => patch({ scope: 'all' })}>View all scans</button>}
            </Empty>
          )}
        </div>
        <footer className="pager">
          <span className="muted">{fmt.num(from)}-{fmt.num(to)} of {fmt.num(data.total)} leads / sorted by {filters.sort}</span>
          <div>
            <button className="ci" title="Previous page" aria-label="Previous page of leads" disabled={filters.page === 0 || loading} onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}><Icon name="previous" size={17}/></button>
            <button className="ci" title="Next page" aria-label="Next page of leads" disabled={to >= data.total || loading} onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}><Icon name="next" size={17}/></button>
          </div>
        </footer>
      </section>
      <p className="hint contact-legend"><span className="ci wa verified" aria-hidden="true"><ProviderIcon provider="whatsapp" size={15} /></span><span>WhatsApp link found on website</span><span className="ci wa" aria-hidden="true"><ProviderIcon provider="whatsapp" size={15} /></span><span>Phone number only · verify before messaging</span><span className="ci sms" aria-hidden="true"><Icon name="sms" size={14} /></span><span>Send SMS in Local Geni</span><span className="ci website" aria-hidden="true"><Icon name="globe" size={14} /></span><span>Visit website</span></p>
    </div>
  );
}
