import { useCallback, useEffect, useRef, useState } from 'react';
import { api, DEFAULT_FILTERS, subscribe } from './lib/api.js';
import SearchConfig from './components/SearchConfig.jsx';
import LiveScanner from './components/LiveScanner.jsx';
import LeadResults from './components/LeadResults.jsx';
import LeadDrawer from './components/LeadDrawer.jsx';
import Analytics from './components/Analytics.jsx';
import { Icon, StatusChip } from './components/ui.jsx';
import { mergeSettings } from './lib/outreach.js';
import EmailWorkspace from './components/EmailWorkspace.jsx';
import EmailComposer from './components/EmailComposer.jsx';
import WhatsAppBatch from './components/WhatsAppBatch.jsx';
import WhatsAppWorkspace from './components/WhatsAppWorkspace.jsx';
import { useWorkspaceAccess } from './components/AuthWorkspace.jsx';
import CrmWorkspace from './components/CrmWorkspace.jsx';
import ListsWorkspace from './components/ListsWorkspace.jsx';
import HomeWorkspace from './components/HomeWorkspace.jsx';
import WorkspaceSearch from './components/WorkspaceSearch.jsx';
import FollowUpsWorkspace from './components/FollowUpsWorkspace.jsx';
import BrandMark from './components/BrandMark.jsx';
import ProviderIcon from './components/ProviderIcon.jsx';
import AskGeni from './components/AskGeni.jsx';
import SmsWorkspace from './components/SmsWorkspace.jsx';
import SmsComposer from './components/SmsComposer.jsx';
import IntegrationsWorkspace from './components/IntegrationsWorkspace.jsx';
import AccountMenu from './components/AccountMenu.jsx';
import SettingsWorkspace, { SETTINGS_VIEWS } from './components/SettingsWorkspace.jsx';
import { useNavigationMotion } from './components/FluidMotion.jsx';

const NAV = [
  ['home', 'compass', 'Dashboard'],
  ['configure', 'search', 'Find businesses'],
  ['followups', 'calendar', 'Follow-ups'],
  ['scanner', 'activity', 'Live scanner'],
  ['leads', 'leads', 'Leads'],
  ['companies', 'building', 'Companies'],
  ['contacts', 'person', 'Contacts'],
  ['deals', 'chart', 'Deals'],
  ['lists', 'list', 'Lists & segments'],
  ['email', 'message', 'Email'],
  ['whatsapp', 'message', 'WhatsApp'],
  ['sms', 'sms', 'SMS'],
  ['analytics', 'chart', 'Analytics'],
  ['export', 'download', 'Export'],
  ['settings', 'settings', 'Settings'],
  ['privacy', 'lock', 'Workspace access'],
  ['fields', 'settings', 'Data & fields'],
  ['system', 'activity', 'System checks'],
  ['categories', 'building', 'Business categories'],
  ['integrations', 'plug', 'Integrations'],
];
const NAV_GROUPS = [
  { label: '', ids: ['home', 'followups'] },
  { label: 'CRM', ids: ['configure', 'leads', 'companies', 'contacts', 'deals', 'lists'] },
  { label: 'Outreach', ids: ['email', 'whatsapp', 'sms'] },
  { label: 'Insights', ids: ['analytics'] },
  { label: 'Workspace', ids: ['integrations', 'settings'] },
];
const VIEW_PERMISSIONS = { configure: 'editLeads', scanner: 'editLeads', email: 'outreach', whatsapp: 'outreach', sms: 'outreach', settings: 'read', system: 'manageWorkspace' };
const ROUTABLE_VIEWS = new Set([...NAV.map(([id]) => id), ...SETTINGS_VIEWS]);
// Settings subsections are real routes too. Keeping them in the same allowlist
// means a refresh on #categories, #fields, or #system lands back in Settings
// instead of silently falling back to the home screen.
const INITIAL_VIEW = ROUTABLE_VIEWS.has(window.location.hash.slice(1)) ? window.location.hash.slice(1) : null;

export default function App() {
  const access = useWorkspaceAccess();
  const canEdit = access.permissions.includes('editLeads');
  const canOutreach = access.permissions.includes('outreach');
  const visibleNav = NAV.filter(([id]) => !VIEW_PERMISSIONS[id] || access.permissions.includes(VIEW_PERMISSIONS[id]));
  const [workspaceDirty, setWorkspaceDirty] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [accessSection, setAccessSection] = useState('account');
  const [crmLeadId, setCrmLeadId] = useState(null);
  const [listSelection, setListSelection] = useState(null);
  const [campaignSeed, setCampaignSeed] = useState(null);
  const consumeCrmLead = useCallback(() => setCrmLeadId(null), []);
  const consumeListSelection = useCallback(() => setListSelection(null), []);
  const consumeCampaign = useCallback(() => setCampaignSeed(null), []);
  const [meta, setMeta] = useState(null);
  const [serverError, setServerError] = useState(null);
  const [view, setView] = useState(INITIAL_VIEW || 'home');
  const [scans, setScans] = useState([]);
  const [scanId, setScanId] = useState(null);
  const [scan, setScan] = useState(null);
  const [apiFeed, setApiFeed] = useState([]);
  const [leadsVersion, setLeadsVersion] = useState(0);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [selected, setSelected] = useState(() => new Set());
  const [leadId, setLeadId] = useState(null);
  const [emailDirty, setEmailDirty] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [whatsAppDirty, setWhatsAppDirty] = useState(false);
  const [whatsAppBusy, setWhatsAppBusy] = useState(false);
  const [emailDraft, setEmailDraft] = useState(null);
  const [whatsAppIDs, setWhatsAppIDs] = useState(null);
  const [whatsAppDraft, setWhatsAppDraft] = useState('');
  const [smsDraft, setSmsDraft] = useState(null);
  const [emailSection, setEmailSection] = useState('inbox');
  const [emailProvider, setEmailProvider] = useState('');
  const [whatsAppSection, setWhatsAppSection] = useState('inbox');
  const [toasts, setToasts] = useState([]);
  const [live, setLive] = useState(false);
  const [settings, setSettings] = useState(() => mergeSettings());
  const [followUps, setFollowUps] = useState({ due: 0, upcoming: 0 });
  const [leadOrder, setLeadOrder] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => { try { return localStorage.getItem('local-geni:sidebar') === 'collapsed'; } catch { return false; } });
  const [collapsedNavGroups, setCollapsedNavGroups] = useState(() => {
    try { return JSON.parse(localStorage.getItem('local-geni:nav-groups') || '{}') || {}; } catch { return {}; }
  });
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem('local-geni:density') === 'compact'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem('local-geni:sidebar', sidebarCollapsed ? 'collapsed' : 'expanded'); } catch {} }, [sidebarCollapsed]);
  useEffect(() => { try { localStorage.setItem('local-geni:nav-groups', JSON.stringify(collapsedNavGroups)); } catch {} }, [collapsedNavGroups]);
  useEffect(() => { try { localStorage.setItem('local-geni:density', compact ? 'compact' : 'comfortable'); } catch {} }, [compact]);
  const menuRef = useRef(null);
  const sidebarRef = useRef(null);
  const navigationMotion = useNavigationMotion(sidebarRef, sidebarOpen);
  const goTo = useCallback((next) => {
    if (!ROUTABLE_VIEWS.has(next)) return false;
    if (VIEW_PERMISSIONS[next] && !access.permissions.includes(VIEW_PERMISSIONS[next])) return false;
    if (next !== view && workspaceBusy) return false;
    if (next !== view && workspaceDirty && !window.confirm('Discard the unsaved workspace changes?')) return false;
    if (next !== view && view === 'email' && emailBusy) return false;
    if (next !== view && view === 'whatsapp' && whatsAppBusy) return false;
    if (next !== view && view === 'email' && emailDirty && !window.confirm('Leave Email and discard unsaved changes?')) return false;
    if (next !== view && view === 'whatsapp' && whatsAppDirty && !window.confirm('Leave WhatsApp and discard unsaved settings?')) return false;
    if (next !== view) setEmailDirty(false);
    if (next !== view) setWhatsAppDirty(false);
    if (next !== view) setWorkspaceDirty(false);
    setView(next);
    setSidebarOpen(false);
    return true;
  }, [view, emailDirty, emailBusy, whatsAppBusy, whatsAppDirty, workspaceDirty, workspaceBusy, access.permissions]);

  useEffect(() => {
    if (VIEW_PERMISSIONS[view] && !access.permissions.includes(VIEW_PERMISSIONS[view])) setView('home');
  }, [view, access.permissions]);

  useEffect(() => { window.history.replaceState(null, '', `#${view}`); setSidebarOpen(false); window.scrollTo(0, 0); }, [view]);
  useEffect(() => {
    const onHash = () => {
      const next = window.location.hash.slice(1);
      if (ROUTABLE_VIEWS.has(next) && !goTo(next)) window.history.replaceState(null, '', `#${view}`);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [goTo, view]);
  useEffect(() => {
    if (!sidebarOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    sidebarRef.current?.querySelector('[aria-current="page"]')?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); setSidebarOpen(false); }
      if (event.key === 'Tab') {
        const controls = [...sidebarRef.current.querySelectorAll('button, a[href]')].filter((el) => !el.disabled && el.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const breakpoint = window.matchMedia('(min-width: 901px)');
    const onResize = () => { if (breakpoint.matches) setSidebarOpen(false); };
    breakpoint.addEventListener('change', onResize);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      breakpoint.removeEventListener('change', onResize);
      document.body.style.overflow = previousOverflow;
      menuRef.current?.focus();
    };
  }, [sidebarOpen]);

  const scanIdRef = useRef(scanId);
  scanIdRef.current = scanId;

  const notify = useCallback((message, kind = 'info') => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-3), { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const refreshScans = useCallback(() => api.get('/scans').then((list) => { setScans(list); return list; }), []);

  useEffect(() => {
    api.get('/meta').then(setMeta).catch((e) => setServerError(e.message));
    api.get('/settings').then((s) => setSettings(mergeSettings(s))).catch(() => {});
    refreshScans().then((list) => {
      const pick = list.find((s) => s.active) || list[0];
      if (pick) { setScanId(pick.id); if (!INITIAL_VIEW && pick.active) setView('scanner'); }
    }).catch(() => {});
  }, [refreshScans]);

  useEffect(() => {
    if (!scanId) { setScan(null); return; }
    api.get(`/scans/${scanId}`).then(setScan).catch(() => {});
  }, [scanId]);

  useEffect(() => { api.get('/followups').then(setFollowUps).catch(() => {}); }, [leadsVersion]);

  // Live events arrive fast during a scan; batch lead-table refreshes to one every 2s.
  const refreshTimer = useRef(null);
  const bumpLeads = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => { refreshTimer.current = null; setLeadsVersion((v) => v + 1); }, 2000);
  }, []);

  useEffect(() => subscribe(({ type, data, ts }) => {
    const mine = data.scanId === scanIdRef.current;
    if (type === 'scan:progress') {
      if (mine) setScan((s) => s && { ...s, stats: { ...s.stats, ...data.stats }, active: data.active, status: data.status || s.status });
      bumpLeads();
    } else if (type === 'scan:log') {
      if (mine) setScan((s) => s && { ...s, logs: [...s.logs.slice(-199), data] });
    } else if (type === 'scan:status') {
      refreshScans().catch(() => {});
      if (mine) api.get(`/scans/${data.scanId}`).then(setScan).catch(() => {});
      if (data.error) notify(`Scan #${data.scanId}: ${data.error}`, 'error');
      else if (data.status === 'paused' && data.note) notify(`Scan #${data.scanId} paused: ${data.note}`, 'error');
      bumpLeads();
    } else if (type === 'lead:updated') {
      bumpLeads();
    } else if (type === 'api') {
      setApiFeed((f) => [{ ...data, ts }, ...f].slice(0, 80));
      if (data.outcome === 'error' && data.httpCode && data.httpCode !== 429) notify(`Places API ${data.httpCode}: ${data.error}`, 'error');
    }
  }, (ok) => { setLive(ok); if (ok) setServerError(null); }), [bumpLeads, refreshScans, notify]);

  const scanAction = useCallback(async (action, id, body) => {
    try {
      if (action === 'delete') {
        await api.del(`/scans/${id}`);
        if (id === scanIdRef.current) setScanId(null);
      } else {
        const s = await api.post(`/scans/${id}/${action}`, body);
        if (id !== scanIdRef.current) setScanId(id);
        setScan(s);
      }
      refreshScans();
    } catch (e) { notify(e.message, 'error'); }
  }, [notify, refreshScans]);

  const openScan = (id) => { setScanId(id); setSelected(new Set()); setFilters((f) => ({ ...f, scope: 'scan', page: 0 })); setView('leads'); };
  const onStarted = (s) => { setScanId(s.id); setScan(s); setSelected(new Set()); setFilters((f) => ({ ...f, scope: 'scan', page: 0 })); setView('scanner'); refreshScans(); };
  const openLeads = (patch, scope) => {
    setSelected(new Set());
    setFilters({ ...DEFAULT_FILTERS, scope: scope === 'scan' && scanId ? 'scan' : 'all', ...patch });
    setView('leads');
  };
  const leadIndex = leadId ? leadOrder.indexOf(leadId) : -1;
  const closeLead = useCallback(() => setLeadId(null), []);
  const bump = useCallback(() => setLeadsVersion((v) => v + 1), []);
  const composeEmail = useCallback((lead, initialText, initialSubject, afterSent, context = {}) => {
    if (!canOutreach) { notify('Your account has view-only access.', 'error'); return; }
    setLeadId(null);
    setEmailDraft({ lead, initialText, initialSubject, afterSent, ...context });
  }, [canOutreach, notify]);
  const composeWhatsApp = useCallback((ids, initialMessage = '') => {
    if (!canOutreach) { notify('Your account has view-only access.', 'error'); return; }
    setLeadId(null);
    setWhatsAppDraft(initialMessage || '');
    setWhatsAppIDs([...ids]);
  }, [canOutreach, notify]);
  const composeSms = useCallback((lead, initialMessage = '') => {
    if (!canOutreach) { notify('Your account has view-only access.', 'error'); return; }
    setLeadId(null);
    setSmsDraft({ lead, initialMessage });
  }, [canOutreach, notify]);
  const importLeadsToCrm = useCallback(async (ids, mode = 'companies') => {
    if (!canEdit) throw new Error('Your account has view-only access.');
    const result = await api.post('/crm/companies/bulk', {
      placeIds: [...new Set(ids)],
      createContacts: mode === 'contacts',
      requestKey: crypto.randomUUID(),
    });
    setSelected(new Set());
    setLeadsVersion(value => value + 1);
    const failed = result.failures?.length || 0;
    const companyCount = result.companies?.created || 0;
    const companyExisting = result.companies?.alreadyInCrm || 0;
    const contactCount = result.contacts?.created || 0;
    const contactExisting = result.contacts?.alreadyInCrm || 0;
    const contactSkipped = result.contacts?.skipped || 0;
    const parts = mode === 'contacts'
      ? [`${contactCount} contact${contactCount === 1 ? '' : 's'} created`, companyCount ? `${companyCount} compan${companyCount === 1 ? 'y' : 'ies'} added` : '', contactExisting ? `${contactExisting} already existed` : '', contactSkipped ? `${contactSkipped} had no phone or email` : ''].filter(Boolean)
      : [`${companyCount} compan${companyCount === 1 ? 'y' : 'ies'} added`, companyExisting ? `${companyExisting} already existed` : ''].filter(Boolean);
    if (failed) parts.push(`${failed} could not be imported`);
    notify(parts.join(' · ') || 'Nothing new was added', failed ? 'info' : 'success');
    const target = mode === 'contacts' && (contactCount || contactExisting) ? 'contacts' : 'companies';
    goTo(target);
    return result;
  }, [canEdit, goTo, notify]);
  const startListCampaign = useCallback((seed) => {
    if (!canOutreach) return;
    setCampaignSeed(seed); setEmailSection('sequences'); setWorkspaceDirty(false); setWorkspaceBusy(false); setView('email');
  }, [canOutreach]);
  const onLeadsDeleted = useCallback((ids) => {
    const removed = new Set(ids);
    setSelected(s => new Set([...s].filter(id => !removed.has(id))));
    setLeadId(id => removed.has(id) ? null : id);
    setLeadOrder(order => order.filter(id => !removed.has(id)));
    setWhatsAppIDs(ids => ids ? ids.filter(id => !removed.has(id)) : null);
    setSmsDraft(draft => draft && removed.has(draft.lead?.place_id) ? null : draft);
    setLeadsVersion(version => version + 1);
    refreshScans().catch(() => {});
    const currentId = scanIdRef.current;
    if (currentId) api.get(`/scans/${currentId}`).then(next => { if (scanIdRef.current === currentId) setScan(next); }).catch(() => {});
  }, [refreshScans]);
  const navigationBusy = workspaceBusy || (view === 'email' && emailBusy) || (view === 'whatsapp' && whatsAppBusy);
  const navView = SETTINGS_VIEWS.includes(view) ? 'settings' : view === 'scanner' ? 'configure' : view;
  const lastNavView = useRef(null);
  useEffect(() => {
    const activeGroup = NAV_GROUPS.find(group => group.label && group.ids.includes(navView));
    const routeChanged = lastNavView.current === null || lastNavView.current !== navView;
    lastNavView.current = navView;
    if (routeChanged && activeGroup && collapsedNavGroups[activeGroup.label]) {
      setCollapsedNavGroups(groups => ({ ...groups, [activeGroup.label]: false }));
    }
  }, [navView, collapsedNavGroups]);
  const navButton = ([id, icon, label]) => <button type="button" key={id} title={label} aria-label={label} disabled={navigationBusy && id !== view} className={navView === id ? 'on' : ''} aria-current={navView === id ? 'page' : undefined} onClick={() => goTo(id)}>{id === 'whatsapp' ? <ProviderIcon provider="whatsapp" size={18} /> : <Icon name={icon} size={18} />}<span>{label}</span>{id === 'configure' && scan?.active && <span className="pulse" />}</button>;

  return (
    <div className={`shell ${sidebarOpen ? 'sidebar-open' : ''} ${sidebarCollapsed ? 'rail-collapsed' : ''}`} data-density={compact ? 'compact' : 'comfortable'} inert={emailDraft || whatsAppIDs || smsDraft ? true : undefined}>
      <a className="skip-link" href="#workspace" onClick={(event) => { event.preventDefault(); document.getElementById('workspace')?.focus(); }}>Skip to content</a>
      {navigationMotion.present && <button ref={navigationMotion.scrim} className="sidebar-scrim fluid-nav-scrim" data-no-press aria-label="Close navigation" tabIndex={-1} onClick={() => setSidebarOpen(false)} />}
      <aside ref={sidebarRef} className="rail" id="app-sidebar" role={sidebarOpen ? 'dialog' : undefined} aria-modal={sidebarOpen ? true : undefined} aria-label={sidebarOpen ? 'Navigation' : undefined}>
        <button type="button" className="brand" aria-label="Go to Local Geni home" onClick={() => goTo('home')}>
          <BrandMark />
          <div><b>Local Geni</b></div>
        </button>
        <button className="icon-btn sidebar-close" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}><Icon name="close" size={17} /></button>
        <nav aria-label="Main navigation">
          {NAV_GROUPS.map(group => {
            const items = group.ids.map(id => visibleNav.find(item => item[0] === id)).filter(Boolean);
            if (!items.length) return null;
            const groupKey = group.label || 'start';
            const groupId = `nav-group-${groupKey.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
            const expanded = !group.label || !collapsedNavGroups[groupKey];
            return <section className={`nav-section ${expanded ? 'is-expanded' : 'is-collapsed'}`} key={groupKey}>
              {group.label && <button type="button" className="nav-section-toggle" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.label} navigation group`} aria-expanded={expanded} aria-controls={groupId} onClick={() => setCollapsedNavGroups(groups => ({ ...groups, [groupKey]: expanded }))}>
                <span className="nav-caption">{group.label}</span><Icon name="chevronDown" size={15} />
              </button>}
              <div id={groupId} className="nav-section-items" hidden={!expanded}>{items.map(navButton)}</div>
            </section>;
          })}
        </nav>
        {scan && (
          <button className="rail-scan" onClick={() => goTo('scanner')}>
            <small>Latest search</small>
            <b>{scan.config.categoryLabel}</b>
            <span>{scan.config.area}, {scan.config.country}</span>
            <StatusChip status={scan.active ? 'running' : scan.status} />
          </button>
        )}
        <div className="rail-foot">
          <span className={`conn ${live ? 'ok' : ''}`} /><div><b>{access.user?.name || 'Local workspace'}</b><small>{live ? (access.configured ? access.role : 'Connected') : 'Connecting...'}</small></div>
        </div>
        <button className="rail-collapse" aria-label={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'} title={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed(value => !value)}><Icon name="sidebar" size={18} /><span>Collapse navigation</span></button>
      </aside>

      <div className="workspace" inert={sidebarOpen || undefined}>
        <header className="toolbar">
          <button ref={menuRef} className="icon-btn menu-toggle" aria-label={sidebarOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={sidebarOpen} aria-controls="app-sidebar" onClick={() => setSidebarOpen((value) => !value)}><Icon name="sidebar" /></button>
          <button type="button" className="toolbar-brand" aria-label="Go to Local Geni home" onClick={() => goTo('home')}><BrandMark size={28} /><span>Local Geni</span></button>
          <WorkspaceSearch navigation={visibleNav.filter(([id]) => NAV_GROUPS.some(group => group.ids.includes(id)))} onNavigate={goTo} onOpenLead={id => { if (!goTo('leads')) return false; setLeadId(id); return true; }} busy={navigationBusy} compact={compact} onToggleDensity={() => setCompact(value => !value)} modalOpen={Boolean(leadId || emailDraft || whatsAppIDs || smsDraft || sidebarOpen)} />
          <div className="toolbar-actions">
            <span className={`workspace-badge ${meta?.qaSimulator ? 'is-sample' : ''}`} title={meta?.qaSimulator ? 'CRM data and API sends are simulated. QR-linked WhatsApp is separate and real.' : 'Stored in your local workspace'}><span className="mode-dot" />{meta?.qaSimulator ? 'Sample / API sandbox' : 'Local workspace'}</span>
            {canOutreach && <AskGeni inToolbar view={view} obscured={Boolean(leadId || emailDraft || whatsAppIDs || smsDraft)} onOpenIntegrations={() => goTo('integrations')}/>} 
            <AccountMenu disabled={navigationBusy} notify={notify} onSetup={() => { if (goTo('privacy')) setAccessSection('account'); }} onTeam={() => { if (goTo('privacy')) setAccessSection('team'); }} beforeSignOut={() => !navigationBusy && (!(workspaceDirty || emailDirty || whatsAppDirty) || window.confirm('Discard unsaved changes and sign out?'))}/>
          </div>
        </header>
      <main className="main" id="workspace" tabIndex={-1}>
        {serverError && <div className="banner error" role="alert">Disconnected. Start Local Geni, then reload. <button className="btn xs" onClick={() => window.location.reload()}>Reload</button></div>}
        {view === 'home' && <HomeWorkspace leadsVersion={leadsVersion} onNavigate={goTo} onOpenLeads={patch => openLeads(patch, 'all')} onOpenLead={setLeadId} followUps={followUps} canEdit={canEdit} canOutreach={canOutreach} simulated={meta?.qaSimulator} />}
        {view === 'integrations' && <IntegrationsWorkspace meta={meta} permissions={access.permissions} onDirtyChange={setWorkspaceDirty} onBusyChange={setWorkspaceBusy} onOpen={target => { if (!goTo(target.view)) return; if (target.view === 'email') { setEmailSection(target.section || 'mailboxes'); setEmailProvider(target.provider || ''); } if (target.view === 'whatsapp') setWhatsAppSection(target.section || 'inbox'); }} />}
        {view === 'followups' && <FollowUpsWorkspace leadsVersion={leadsVersion} onOpenLead={setLeadId} onOpenLeads={() => { if (goTo('leads')) openLeads({ followUp: 'scheduled' }, 'all'); }} />}
        {['companies', 'contacts', 'deals'].includes(view) && <CrmWorkspace key={view} section={view} initialLeadId={crmLeadId} onConsumedLead={consumeCrmLead} notify={notify} onDirtyChange={setWorkspaceDirty} onBusyChange={setWorkspaceBusy} onOpenLead={setLeadId} onComposeEmail={canOutreach ? composeEmail : undefined} readOnly={!canEdit} />}
        {view === 'lists' && <ListsWorkspace initialSelection={listSelection} onConsumedSelection={consumeListSelection} onEmailCampaign={startListCampaign} onWhatsApp={composeWhatsApp} onOpenLead={setLeadId} notify={notify} onDirtyChange={setWorkspaceDirty} onBusyChange={setWorkspaceBusy} readOnly={!canEdit} canOutreach={canOutreach} />}
        {['configure', 'scanner'].includes(view) && <>
          {scan && <nav className="discovery-tabs" aria-label="Find businesses views"><button className={view === 'configure' ? 'on' : ''} aria-current={view === 'configure' ? 'page' : undefined} onClick={() => goTo('configure')}><Icon name="search" size={15}/>New search</button><button className={view === 'scanner' ? 'on' : ''} aria-current={view === 'scanner' ? 'page' : undefined} onClick={() => goTo('scanner')}><Icon name="activity" size={15}/>{scan.active ? 'Search in progress' : 'Search activity'}</button></nav>}
          {view === 'configure' || !scan ? <SearchConfig meta={meta} scans={scans} onStarted={onStarted} onOpenScan={openScan} notify={notify} onManageCategories={() => goTo('categories')} onManageIntegrations={() => goTo('integrations')}/> : <LiveScanner scan={scan} scans={scans} apiFeed={apiFeed} leadsVersion={leadsVersion} onAction={scanAction} onOpenScan={openScan} onOpenLead={setLeadId} onNew={() => goTo('configure')}/>}
        </>}
        {view === 'leads' && (
          <LeadResults scanId={scanId} filters={filters} setFilters={setFilters} selected={selected} setSelected={setSelected}
            leadsVersion={leadsVersion} onOpenLead={setLeadId} onComposeEmail={composeEmail} onComposeWhatsApp={canOutreach ? composeWhatsApp : undefined} onComposeSms={canOutreach ? composeSms : undefined} onExport={() => goTo('export')} onShortlist={canEdit ? ids => { if (goTo('lists')) setListSelection({ ids }); } : undefined} onCreateCrm={canEdit ? importLeadsToCrm : undefined} onDeleted={onLeadsDeleted} notify={notify} settings={settings} onOrder={setLeadOrder} followUps={followUps} />
        )}
        {view === 'email' && <EmailWorkspace notify={notify} initialProvider={emailProvider} initialSection={emailSection} initialCampaign={campaignSeed} onConsumedCampaign={consumeCampaign} onDirtyChange={setEmailDirty} onBusyChange={setEmailBusy} onComposeEmail={composeEmail} onOpenLead={setLeadId} onOpenPublishing={() => goTo('system')} />}
        {view === 'whatsapp' && <WhatsAppWorkspace initialSection={whatsAppSection} notify={notify} onDirtyChange={setWhatsAppDirty} onBusyChange={setWhatsAppBusy} onOpenLeads={() => { if (goTo('leads')) openLeads({}, 'all'); }} />}
        {view === 'analytics' && <Analytics scanId={scanId} leadsVersion={leadsVersion} onOpen={openLeads} />}
        {SETTINGS_VIEWS.includes(view) && <SettingsWorkspace view={view} onNavigate={goTo} meta={meta} notify={notify} scanId={scanId} filters={filters} selected={selected} onChanged={bump} onOpenLeads={() => goTo('leads')} initialAccessSection={accessSection} onDirtyChange={setWorkspaceDirty} onBusyChange={setWorkspaceBusy} busy={workspaceBusy}/> }
        {view === 'sms' && <SmsWorkspace notify={notify} onOpenIntegrations={() => goTo('integrations')} onDirtyChange={setWorkspaceDirty} onBusyChange={setWorkspaceBusy} />}
      </main>
      </div>

      {leadId && (
        <LeadDrawer placeId={leadId} onClose={closeLead} onChanged={bump} onDeleted={onLeadsDeleted} leadsVersion={leadsVersion} notify={notify} settings={settings} onComposeEmail={composeEmail} onComposeWhatsApp={canOutreach ? composeWhatsApp : undefined} onComposeSms={canOutreach ? composeSms : undefined}
          position={leadIndex >= 0 ? `${leadIndex + 1} of ${leadOrder.length}` : null}
          onPrev={leadIndex > 0 ? () => setLeadId(leadOrder[leadIndex - 1]) : null}
          onNext={leadIndex >= 0 && leadIndex < leadOrder.length - 1 ? () => setLeadId(leadOrder[leadIndex + 1]) : null} />
      )}
      {emailDraft && <EmailComposer key={emailDraft.lead.place_id} {...emailDraft} notify={notify} onClose={() => setEmailDraft(null)} onSent={() => { bump(); emailDraft.afterSent?.(); }} onOpenSettings={() => { if(goTo('email')) { setEmailSection('mailboxes'); setEmailDraft(null); } }} />}
      {whatsAppIDs && <WhatsAppBatch selectedIDs={whatsAppIDs} settings={settings} initialMessage={whatsAppDraft} notify={notify} onClose={() => { setWhatsAppIDs(null); setWhatsAppDraft(''); }} onChanged={bump} onOpenSettings={() => { if (goTo('whatsapp')) { setWhatsAppSection('connection'); setWhatsAppIDs(null); setWhatsAppDraft(''); } }} />}
      {smsDraft && <SmsComposer key={smsDraft.lead.place_id} {...smsDraft} notify={notify} onClose={() => setSmsDraft(null)} onSent={() => { bump(); }} onOpenSettings={() => { if (goTo('integrations')) setSmsDraft(null); }} />}

      <div className="toasts" aria-live="polite" aria-relevant="additions">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}><Icon name={t.kind === 'error' ? 'alert' : 'check'} size={18} /><span>{t.message}</span><button aria-label="Dismiss notification" onClick={() => setToasts((items) => items.filter((item) => item.id !== t.id))}><Icon name="close" size={15} /></button></div>)}
      </div>
    </div>
  );
}
