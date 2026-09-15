import { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmt } from '../lib/api.js';
import MapView from './MapView.jsx';
import CoverageGrid from './CoverageGrid.jsx';
import { Icon, PageHead } from './ui.jsx';
import CategoryPicker, { CATEGORY_LANGUAGES } from './CategoryPicker.jsx';
import { buildSearchPlan, DEFAULT_LEAD_FILTERS, normalizeLeadFilters } from '../../../shared/searchPlan.js';

const LS_KEY = 'leadscout.config';
const DEFAULTS = { country: 'OM', area: '', category: '', categoryId: null, language: 'en', keywords: '',
  targetCount: 100, targetMode: 'discovered', maxApiCalls: 150, radiusKm: 1, cellKm: 1,
  coverageMode: 'area', completionMode: 'coverage', filters: DEFAULT_LEAD_FILTERS };
const SectionHead = ({ icon, title, description }) => <div className="search-card-heading"><span className="search-heading-icon"><Icon name={icon} size={18}/></span><div><h2>{title}</h2>{description && <p>{description}</p>}</div></div>;

export default function SearchConfig({ meta, scans, onStarted, onOpenScan, notify, onManageCategories, onManageIntegrations }) {
  const [hasSaved] = useState(() => { try { return Boolean(localStorage.getItem(LS_KEY)); } catch { return false; } });
  const [form, setForm] = useState(() => {
    let saved = {}; try { saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { /* storage blocked */ }
    return { ...DEFAULTS, ...saved, category: saved.category ?? saved.customCategory ?? '', filters: { ...DEFAULT_LEAD_FILTERS, ...saved.filters } };
  });
  const [area, setArea] = useState(null), [bounds, setBounds] = useState(null), [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(''), [usage, setUsage] = useState(null);
  const [searchError, setSearchError] = useState('');
  const overview = useRef(null);
  const [overviewVisible, setOverviewVisible] = useState(false);
  useEffect(() => {
    if (!overview.current) return;
    const observer = new IntersectionObserver(([entry]) => setOverviewVisible(entry.isIntersecting), { threshold: 0.25 });
    observer.observe(overview.current);
    return () => observer.disconnect();
  }, [Boolean(meta)]);
  useEffect(() => { api.get('/limits').then(u => {
    setUsage(u);
    if (!hasSaved) setForm(f => ({ ...f, targetCount: u.limits.defaultTargetCount, maxApiCalls: u.limits.defaultScanBudget }));
  }).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(form)); } catch { /* storage blocked */ } }, [form]);
  useEffect(() => { setArea(null); setBounds(null); setEdited(false); }, [form.country, form.area, form.radiusKm, form.coverageMode]);
  const set = key => event => setForm(f => ({ ...f, [key]: event.target.value }));
  const filter = key => event => { const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value; setForm(f => ({ ...f, filters: { ...f.filters, [key]: value } })); };
  const typed = (form.category || '').trim();
  const match = meta?.categories?.find(c => c.label.toLowerCase() === typed.toLowerCase());
  const payload = { ...form, categoryId: form.categoryId || match?.id || null, customCategory: typed };
  const running = scans.find(s => s.active), nearby = form.coverageMode === 'radius', coverageGoal = form.completionMode === 'coverage';
  const planned = useMemo(() => {
    if (!bounds) return {};
    try { return { plan: buildSearchPlan(bounds, Number(form.cellKm)) }; } catch (error) { return { error: error.message }; }
  }, [bounds, form.cellKm]);
  const { plan } = planned;
  const toggleFilter = (key, value) => setForm(f => ({ ...f, filters: { ...f.filters, [key]: f.filters[key] === value ? DEFAULT_LEAD_FILTERS[key] : value } }));
  const filterLabels = [
    Number(form.filters.minRating) > 0 && `${form.filters.minRating}+ stars`,
    Number(form.filters.minReviews) > 0 && `${fmt.num(Number(form.filters.minReviews))}+ reviews`,
    form.filters.maxReviews !== '' && form.filters.maxReviews != null && `Up to ${fmt.num(Number(form.filters.maxReviews))} reviews`,
    ({ missing: 'No website', social: 'Social page only', present: 'Has a website' })[form.filters.website],
    form.filters.phoneOnly && 'Phone listed', form.filters.newOnly && 'New to CRM',
    form.filters.status === 'operational' && 'Operational only', form.filters.status === 'any' && 'Includes closed listings',
  ].filter(Boolean);
  const countryName = meta?.countries?.find(c => c.code === form.country)?.name || form.country;
  const languageName = CATEGORY_LANGUAGES.find(([code]) => code === form.language)?.[1] || form.language;
  const sample = Boolean(meta?.qaSimulator || area?.simulated);
  const canPreview = Boolean(form.area.trim()) && (!nearby || (Number(form.radiusKm) >= 0.5 && Number(form.radiusKm) <= 50));
  const blockedReason = running ? `Search #${running.id} is running. Pause it before starting another.`
    : sample ? 'You are in the Sample / API sandbox. Live Google searches are disabled here. Open a connected workspace to search real businesses.'
    : !meta?.placesKeyConfigured ? 'Connect Google Places to find real businesses.'
    : !typed ? 'Choose a business type to continue.'
    : !form.area.trim() ? 'Enter a city or neighbourhood to continue.'
    : planned.error || '';


  function reviewSearch() {
    overview.current?.focus({ preventScroll: true });
    overview.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  }
  async function preview() {
    setBusy('preview'); setSearchError('');
    try {
      const resolved = await api.post('/area/resolve', payload); setArea(resolved); setBounds(resolved.bounds); setEdited(false);
      if (window.matchMedia('(max-width: 980px)').matches) reviewSearch();
    }
    catch (error) { setSearchError(`We couldn’t preview this area. ${error.message}`); } finally { setBusy(''); }
  }
  async function start(event) {
    event.preventDefault();
    try { normalizeLeadFilters(form.filters); } catch (error) { notify(error.message, 'error'); return; }
    if (busy || blockedReason) return;
    setBusy('start'); setSearchError('');
    try {
      // Preview is optional. Resolve the location here when the user starts directly.
      const resolved = bounds ? { ...area, bounds } : await api.post('/area/resolve', payload);
      if (!bounds) { setArea(resolved); setBounds(resolved.bounds); setEdited(false); }
      const scan = await api.post('/scans', { ...payload, bounds: nearby ? undefined : resolved.bounds, center: nearby ? resolved.center : undefined });
      notify(`Search #${scan.id} started`, 'success'); onStarted(scan);
    } catch (error) { setSearchError(`The search didn’t start. ${error.message}`); } finally { setBusy(''); }
  }
  if (!meta) return <div className="loading" role="status">Getting your search ready…</div>;

  return <div className="page search-page">
    <PageHead title="Find businesses" description="Choose who you want to reach and where to look." />
    <form className="search-builder" onSubmit={start} onInvalidCapture={event => { const details = event.target.closest('details'); if (details) details.open = true; }}>
      <fieldset className="search-builder-fields" disabled={Boolean(busy)}>
        <section className="card search-essentials">
          <SectionHead icon="search" title="What are you looking for?" />
          <div className="search-category-field"><span className="search-field-label">Business type</span>
            <CategoryPicker value={form.category} selectedId={form.categoryId} country={form.country} language={form.language} fallback={meta.categories} onChange={(category, categoryId) => setForm(current => ({ ...current, category, categoryId }))}/>
          </div>
          <div className="search-location-fields">
            <label className="field"><span>Country</span><select value={form.country} onChange={set('country')}>{meta.countries.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
            <label className="field"><span>City or neighbourhood</span><input value={form.area} onChange={set('area')} placeholder="e.g. Gulberg, Lahore" required maxLength={200}/></label>
          </div>
          <div className="search-coverage-fields">
            <span className="search-field-label">Where should we search?</span>
            <div className="coverage-choice" aria-label="Search coverage">
              <button type="button" aria-pressed={!nearby} className={!nearby ? 'selected' : ''} onClick={() => setForm(f => ({ ...f, coverageMode: 'area' }))}><Icon name="grid" size={18}/><span>Across the area<small>Search neighbourhood by neighbourhood</small></span><span className="coverage-radio">{!nearby && <Icon name="check" size={12}/>}</span></button>
              <button type="button" aria-pressed={nearby} className={nearby ? 'selected' : ''} onClick={() => setForm(f => ({ ...f, coverageMode: 'radius' }))}><Icon name="target" size={18}/><span>Within a radius<small>Stay close to a specific location</small></span><span className="coverage-radio">{nearby && <Icon name="check" size={12}/>}</span></button>
            </div>
            <div className="search-coverage-options">
              {nearby && <label className="field radius-field"><span>Radius · km</span><input type="number" min="0.5" max="50" step="0.5" value={form.radiusKm} onChange={set('radiusKm')}/></label>}
              <label className="field"><span>Search area size</span><select value={form.cellKm} onChange={set('cellKm')}><option value="0.5">0.5 km · extra detail</option><option value="1">1 km · detailed</option><option value="2">2 km · balanced</option><option value="5">5 km · wider areas</option></select></label>
              <p className="hint">{nearby ? 'Use a neighbourhood or address for a precise centre.' : 'Smaller areas help uncover more businesses.'} Busy areas are split further.</p>
            </div>
          </div>
        </section>
        <section className="card search-filters-card">
          <div className="search-section-title"><SectionHead icon="settings" title="Focus your results" />{filterLabels.length > 0 && <button type="button" className="link" onClick={() => setForm(f => ({ ...f, filters: { ...DEFAULT_LEAD_FILTERS } }))}>Reset filters</button>}</div>
          <div className="search-quick-filters" aria-label="Quick lead filters">
            <button type="button" aria-pressed={form.filters.website === 'missing'} onClick={() => toggleFilter('website', 'missing')}><Icon name="globe" size={15}/>No website{form.filters.website === 'missing' && <Icon name="check" size={14}/>}</button>
            <button type="button" aria-pressed={Boolean(form.filters.phoneOnly)} onClick={() => toggleFilter('phoneOnly', true)}><Icon name="phone" size={15}/>Phone listed{form.filters.phoneOnly && <Icon name="check" size={14}/>}</button>
            <button type="button" aria-pressed={Boolean(form.filters.newOnly)} onClick={() => toggleFilter('newOnly', true)}><Icon name="plus" size={15}/>New to CRM{form.filters.newOnly && <Icon name="check" size={14}/>}</button>
          </div>
          <details className="search-disclosure">
            <summary><span>More filters{filterLabels.length > 0 && <span className="search-count">{filterLabels.length} active</span>}</span><Icon name="next" size={16}/></summary>
            <div className="search-disclosure-content">
              <div className="lead-filter-grid">
                <label className="field"><span>Minimum rating</span><select value={form.filters.minRating} onChange={filter('minRating')}><option value="0">Any rating</option>{[3, 3.5, 4, 4.5, 4.8].map(n => <option value={n} key={n}>{n}+ stars</option>)}</select></label>
                <label className="field"><span>Website presence</span><select value={form.filters.website} onChange={filter('website')}><option value="any">Any web presence</option><option value="missing">No website listed</option><option value="social">Social page listed</option><option value="present">Business website listed</option></select></label>
                <label className="field"><span>Minimum reviews</span><input type="number" min="0" step="1" max="10000000" value={form.filters.minReviews} onChange={filter('minReviews')}/></label>
                <label className="field"><span>Maximum reviews</span><input type="number" min={Number(form.filters.minReviews) || 0} step="1" max="10000000" value={form.filters.maxReviews ?? ''} placeholder="No maximum" onChange={filter('maxReviews')}/></label>
                <label className="field"><span>Business status</span><select value={form.filters.status} onChange={filter('status')}><option value="exclude_closed">Exclude closed listings</option><option value="operational">Google marks as operational</option><option value="any">Any listing status</option></select></label>
              </div>
              <p className="hint">Set a review maximum to find smaller businesses. Businesses with missing required details are excluded. A listed phone does not confirm permission to contact.</p>
            </div>
          </details>
          <p className="search-filter-summary">{filterLabels.length ? filterLabels.join(' · ') : 'All matching businesses. Closed listings excluded.'}</p>
        </section>
        <section className="card search-options-card">
          <SectionHead icon="target" title="Set your search goal" />
          <div className="search-goal-fields">
            <label className="field"><span>Search until</span><select value={form.completionMode} onChange={set('completionMode')}><option value="coverage">The whole area is covered</option><option value="target">I reach my lead target</option></select></label>
            <label className="field"><span>Request budget</span><input type="number" min="1" max="10000" step="1" value={form.maxApiCalls} onChange={set('maxApiCalls')}/></label>
          </div>
          {!coverageGoal && <div className="search-goal-fields"><label className="field"><span>Lead target</span><input type="number" min="1" max="5000" step="1" value={form.targetCount} onChange={set('targetCount')}/></label><label className="field"><span>Count toward target</span><select value={form.targetMode} onChange={set('targetMode')}><option value="discovered">All matching businesses</option><option value="qualified">Hot + Potential leads</option></select></label></div>}
          <p className="hint">Pauses at your budget. Resume any time to keep searching.</p>
          <details className="search-disclosure">
            <summary><span>Language & keywords<small>{languageName}{form.keywords.trim() ? ' · Keywords added' : ''}</small></span><Icon name="next" size={16}/></summary>
            <div className="search-disclosure-content">
              <div className="lead-filter-grid"><label className="field"><span>Result language</span><select value={form.language} onChange={set('language')}>{CATEGORY_LANGUAGES.map(([code, name]) => <option value={code} key={code}>{name}</option>)}{!CATEGORY_LANGUAGES.some(([code]) => code === form.language) && <option value={form.language}>{form.language}</option>}</select></label><label className="field"><span>Extra keywords <em>optional</em></span><input value={form.keywords} onChange={set('keywords')} placeholder="e.g. men's haircuts" maxLength={100}/></label></div>
              {onManageCategories && <button type="button" className="link category-settings-link" onClick={onManageCategories}><Icon name="settings" size={14}/>Manage business categories</button>}
            </div>
          </details>
        </section>
      </fieldset>
      <aside className="search-overview" ref={overview} tabIndex={-1} aria-label="Search overview">
        <section className="card search-overview-card">
          <div className="search-overview-heading"><h2>Search overview</h2><span className={`search-preview-status ${bounds && !sample ? 'confirmed' : ''}`}>{sample ? 'Sample' : bounds ? edited ? 'Adjusted' : 'Area ready' : 'Draft'}</span></div>
          <div className="search-overview-target"><span className="search-target-icon"><Icon name="building" size={21}/></span><div><h3>{typed || 'Your next leads'}</h3><p><Icon name="map" size={13}/>{form.area.trim() ? `${form.area.trim()}, ${countryName}` : 'Choose a business and location'}</p></div></div>
          <div className="search-overview-scope"><Icon name={nearby ? 'target' : 'grid'} size={15}/><span>{nearby ? `${form.radiusKm} km radius` : 'Across the selected area'}<small>{form.cellKm} km search areas</small></span></div>
          {bounds && !sample && <MapView bounds={bounds} editable={!nearby && !busy} circle={nearby ? { center: area.center, radiusKm: Number(form.radiusKm) } : null} onBoundsChange={b => { setBounds(b); setEdited(true); }} height={220}/>}
          {plan && sample ? <div className="search-coverage-preview">
            <CoverageGrid preview bounds={bounds} cells={plan.cells} radius={nearby ? { center: area.center, radiusKm: Number(form.radiusKm) } : null}/>
            {sample && <p className="hint">Example grid only. This is not a map of {form.area.trim() || 'your location'}.</p>}
          </div> : !bounds ? <div className="search-preview-empty"><Icon name="map" size={24}/><strong>See where we’ll search</strong><p>Preview your location to check the area.</p></div> : null}
          <div className="search-overview-stats"><div><span>Search areas</span><strong>{plan ? fmt.num(plan.count) : '—'}</strong></div><div><span>Request budget</span><strong>{fmt.num(Number(form.maxApiCalls) || 0)}</strong></div></div>
          {planned.error && <p className="hint warn" role="alert">{planned.error}</p>}
          {coverageGoal && plan && Number(form.maxApiCalls) < plan.count && <p className="hint warn">Your budget may pause the search before all {fmt.num(plan.count)} areas are covered. Progress will be saved.</p>}
          <details className="search-disclosure coverage-explainer"><summary><span>How coverage works</span><Icon name="next" size={16}/></summary><div className="search-disclosure-content"><p className="hint">{plan ? `At least ${fmt.num(plan.count)} requests without cache. ` : ''}More pages and crowded areas use extra requests. Location lookups are separate.</p><p className="hint">{area?.expanded && !nearby ? `This location resolved to a point. The preview covers approximately ${form.radiusKm} km around it. ` : ''}{nearby ? 'Only businesses inside the circle are added.' : 'The map boundary is not an official town boundary. Adjust it to match your target.'} Google does not guarantee every business will be returned.</p></div></details>
          <div className="search-launch">
            {searchError && <p className="search-error" role="alert">{searchError} Your search settings are unchanged.</p>}
            {usage && <p className="search-allowance"><Icon name="activity" size={14}/>{usage.remaining.month == null ? 'No monthly search limit' : `${fmt.num(usage.remaining.month)} requests left this month`}{usage.remaining.today != null ? ` · ${fmt.num(usage.remaining.today)} today` : ''}</p>}
          <div className="search-launch-buttons"><button type="button" className={`btn ${!bounds || sample ? 'primary' : ''}`} onClick={preview} disabled={Boolean(busy) || !canPreview}><Icon name={busy === 'preview' ? 'loading' : 'map'} size={16}/>{busy === 'preview' ? 'Locating…' : bounds ? 'Update preview' : 'Preview area'}</button><button type="submit" className={`btn ${!sample ? 'primary' : ''}`} disabled={Boolean(busy || blockedReason)} aria-describedby={blockedReason ? 'search-blocked-reason' : undefined}><Icon name="search" size={16}/>{busy === 'start' ? 'Starting…' : 'Start search'}</button></div>
            {blockedReason && <p className="search-next-step" id="search-blocked-reason" role="status">{blockedReason}</p>}
            {!meta.placesKeyConfigured && onManageIntegrations && <button type="button" className="link search-connect-link" disabled={Boolean(busy)} onClick={onManageIntegrations}><Icon name="plug" size={14}/>Google Places connection<Icon name="arrowUpRight" size={14}/></button>}
          </div>
        </section>
      </aside>
      <div className={`search-mobile-action ${overviewVisible ? 'is-hidden' : ''}`}><button type="button" className="btn" onClick={reviewSearch}><Icon name="map" size={16}/>Review search<Icon name="next" size={16}/></button></div>
    </form>
    {scans.length > 0 && <details className="card recent-searches search-disclosure"><summary><span><Icon name="clock" size={16}/>Open a recent search<span className="search-count">{Math.min(scans.length, 10)}</span></span><Icon name="next" size={16}/></summary><div className="chips search-disclosure-content">{scans.slice(0, 10).map(scan => <button key={scan.id} type="button" className="chip-btn" disabled={Boolean(busy)} aria-label={`Open leads from ${scan.config.categoryLabel} in ${scan.config.area}, ${scan.config.country}`} onClick={() => onOpenScan?.(scan.id)}>{scan.config.categoryLabel} / {scan.config.area}, {scan.config.country}</button>)}</div></details>}
  </div>;
}
