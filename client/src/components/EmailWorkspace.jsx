import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import EmailSettings from './EmailSettings.jsx';
import EmailInfrastructure from './EmailInfrastructure.jsx';
import InboxWorkspace, { IncomingMailSettings } from './InboxWorkspace.jsx';
import CampaignWorkspace from './CampaignWorkspace.jsx';
import '../email-workflows.css';

const PRIMARY = [['inbox', 'Inbox'], ['sequences', 'Sequences'], ['mailboxes', 'Mailboxes']];
const SETUP = [['domain', 'Domain & DNS'], ['verification', 'Address checks'], ['rules', 'Sending rules'], ['suppression', 'Do not contact'], ['history', 'Send history']];
const normalizeSection = (section) => section === 'mailbox' ? 'mailboxes' : section === 'campaigns' ? 'sequences' : section;

export default function EmailWorkspace({ notify, onDirtyChange, onBusyChange, onComposeEmail, onOpenLead, onOpenPublishing, initialSection = 'inbox', initialProvider = '', initialCampaign, onConsumedCampaign }) {
  const [section, setSection] = useState(normalizeSection(initialSection));
  const [setupOpen, setSetupOpen] = useState(SETUP.some(([key]) => key === initialSection));
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [dirty, setDirty] = useState(false);
  const [childBusy, setChildBusy] = useState(false);
  const busyParts = useRef({});
  const setPartBusy = useCallback((part, value) => { busyParts.current[part] = value; setChildBusy(Object.values(busyParts.current).some(Boolean)); }, []);
  const mainBusyChanged = useCallback((value) => setPartBusy('main', value), [setPartBusy]);
  const inboundBusyChanged = useCallback((value) => setPartBusy('inbound', value), [setPartBusy]);
  useEffect(() => { onBusyChange?.(Boolean(busy) || childBusy); return () => onBusyChange?.(false); }, [busy, childBusy, onBusyChange]);
  const dirtyParts = useRef({});
  const alive = useRef(true);
  const chosen = useRef('');
  const parentDirty = useRef(onDirtyChange); parentDirty.current = onDirtyChange;
  const setPartDirty = useCallback((part, value) => {
    dirtyParts.current[part] = value;
    const next = Object.values(dirtyParts.current).some(Boolean); setDirty(next); parentDirty.current?.(next);
  }, []);
  const changed = useCallback((value) => setPartDirty('main', value), [setPartDirty]);
  const inboundChanged = useCallback((value) => setPartDirty('inbound', value), [setPartDirty]);
  const loadAccounts = useCallback(async () => {
    const data = await api.get('/email/accounts');
    if (!alive.current) return;
    const rows = data.rows || []; setAccounts(rows);
    const preferred = initialProvider ? rows.find(row => row.provider === initialProvider && row.configured) || rows.find(row => row.provider === initialProvider) : null;
    const next = rows.some((row) => String(row.id) === String(chosen.current)) ? chosen.current : preferred?.id || (initialProvider ? '' : data.currentAccountId || rows[0]?.id || '');
    if (initialProvider && !next) setAdding(true);
    chosen.current = next; setAccountId(next); return rows;
  }, [initialProvider]);
  const refreshAccounts = useCallback(async () => {
    try { return await loadAccounts(); } catch (err) { if (alive.current) setError(err.message); return []; }
  }, [loadAccounts]);
  useEffect(() => {
    alive.current = true;
    loadAccounts().catch((err) => { if (alive.current) setError(err.message); }).finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; parentDirty.current?.(false); };
  }, [loadAccounts]);
  useEffect(() => {
    const next = normalizeSection(initialSection); setSection(next); if (SETUP.some(([key]) => key === next)) setSetupOpen(true);
  }, [initialSection]);
  useEffect(() => { setPartDirty('add', Boolean(label.trim()) || Boolean(busy)); }, [label, busy, setPartDirty]);
  function canLeave() { return !busy && !childBusy && (!dirty || window.confirm('Discard the unsaved email changes?')); }
  function clearDirty() { dirtyParts.current = {}; setDirty(false); parentDirty.current?.(false); }
  function navigate(next) {
    if (next === section || !canLeave()) return;
    clearDirty(); setAdding(false); setLabel(''); setSection(next);
  }
  async function selectAccount(id) {
    if (String(id) === String(accountId) || !canLeave()) return;
    setBusy('select'); setError('');
    try { await api.post(`/email/accounts/${encodeURIComponent(id)}/select`); clearDirty(); chosen.current = id; setAccountId(id); setLabel(''); setAdding(false); }
    catch (err) { setError(err.message); } finally { setBusy(''); }
  }
  async function addAccount(event) {
    event.preventDefault(); if (busy || !label.trim()) return; setBusy('add'); setError('');
    try {
      const result = await api.post('/email/accounts', { label: label.trim() });
      const next = result.account || result.settings || result;
      if (!next.id && !next.accountId) throw new Error('Mailbox created. Refresh the list to continue.');
      const id = next.id || next.accountId;
      await api.post(`/email/accounts/${encodeURIComponent(id)}/select`);
      chosen.current = id; setAccountId(id); setLabel(''); setAdding(false); clearDirty(); setSection('mailboxes'); await loadAccounts();
      notify?.('Mailbox added', 'success');
    } catch (err) { setError(err.message); } finally { setBusy(''); }
  }
  const account = accounts.find((row) => String(row.id) === String(accountId));
  return <div className="email-workspace">
    <div className="email-workspace-top"><nav className="email-section-nav email-primary-nav" aria-label="Email workspace sections">{PRIMARY.map(([key, text]) => <button key={key} className={section === key ? 'on' : ''} aria-current={section === key ? 'page' : undefined} disabled={Boolean(busy) || childBusy} onClick={() => navigate(key)}>{text}</button>)}<button className={SETUP.some(([key]) => key === section) ? 'on' : ''} aria-expanded={setupOpen} aria-controls="email-setup-navigation" onClick={() => setSetupOpen((value) => !value)}>Setup</button></nav>{['inbox', 'mailboxes', 'history'].includes(section) && <label className="email-account-switch"><span>Mailbox</span><select aria-label="Current mailbox" value={accountId} disabled={loading || Boolean(busy) || childBusy || !accounts.length} onChange={(event) => selectAccount(event.target.value)}>{!accountId && <option value="">Choose mailbox</option>}{accounts.map((item) => <option key={item.id} value={item.id}>{item.fromEmail || item.label || `Mailbox ${item.id}`}</option>)}</select></label>}</div>
    {setupOpen && <nav id="email-setup-navigation" className="email-setup-nav" aria-label="Email setup sections">{SETUP.map(([key, text]) => <button key={key} className={section === key ? 'on' : ''} aria-current={section === key ? 'page' : undefined} disabled={Boolean(busy) || childBusy} onClick={() => navigate(key)}>{text}</button>)}</nav>}
    {error && <div className="email-status-note bad" role="alert"><p>{error}</p><button className="btn xs" disabled={Boolean(busy)} onClick={async () => { try { await loadAccounts(); setError(''); } catch (err) { setError(err.message); } }}>Retry</button></div>}
    {loading ? <section className="card" role="status">Loading mailboxes...</section> : section === 'mailboxes' ? <>
      <header className="page-head mailbox-management"><div><h1>Mailboxes</h1></div><button className="btn" disabled={Boolean(busy)} onClick={() => { if (!canLeave()) return; clearDirty(); setAdding(true); }}>Add mailbox</button></header>
      {adding && <form className="card mailbox-add-form" onSubmit={addAccount}><label className="field grow"><span>Mailbox name</span><input autoFocus required maxLength={100} disabled={Boolean(busy)} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Work" /></label><div className="preview-actions"><button type="button" className="btn" disabled={Boolean(busy)} onClick={() => { setAdding(false); setLabel(''); }}>Cancel</button><button className="btn primary" disabled={Boolean(busy) || !label.trim()}>{busy === 'add' ? 'Adding...' : 'Add mailbox'}</button></div></form>}
      {account && !adding ? <EmailSettings initialProvider={initialProvider} key={accountId} accountId={accountId} notify={notify} onChanged={refreshAccounts} onDirtyChange={changed} onBusyChange={mainBusyChanged}><IncomingMailSettings accountId={accountId} account={account} notify={notify} onChanged={refreshAccounts} onDirtyChange={inboundChanged} onBusyChange={inboundBusyChanged} /></EmailSettings> : !adding && <section className="card workflow-empty"><h3>No mailboxes</h3><button className="btn primary" onClick={() => setAdding(true)}>Add mailbox</button></section>}
    </> : section === 'inbox' ? <InboxWorkspace key={`inbox-${accountId}`} accountId={accountId} account={account} notify={notify} onComposeEmail={onComposeEmail} onOpenLead={onOpenLead} onOpenSettings={() => navigate('mailboxes')} />
      : section === 'sequences' ? <CampaignWorkspace accountId={accountId} initialDraft={initialCampaign} onConsumedDraft={onConsumedCampaign} notify={notify} onDirtyChange={changed} onBusyChange={mainBusyChanged} onOpenSettings={() => navigate('mailboxes')} onOpenPublishing={onOpenPublishing} />
        : <EmailInfrastructure key={`${section}-${section === 'history' ? accountId : 'shared'}`} section={section} accountId={accountId} notify={notify} onDirtyChange={changed} onBusyChange={mainBusyChanged} />}
  </div>;
}
