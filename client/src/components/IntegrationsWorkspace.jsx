import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon, PageHead } from './ui.jsx';
import ProviderIcon from './ProviderIcon.jsx';
import IntegrationConnection from './IntegrationConnection.jsx';
import { INTEGRATIONS } from '../../../shared/integrations.js';
import '../integrations.css';

const desktop = Boolean(window.localGeniDesktop?.version === 1);
const statusFor = (value, loading, unavailable) => loading ? 'Loading...' : unavailable ? 'Unavailable' : value?.verified ? 'Verified' : value?.configured ? 'Verify' : 'Not connected';

export default function IntegrationsWorkspace({ meta, permissions = [], onOpen, onDirtyChange, onBusyChange }) {
  const [data, setData] = useState({});
  const [failed, setFailed] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [help, setHelp] = useState('');
  const [selection, setSelection] = useState('');
  const [editingDirty, setEditingDirty] = useState(false);
  const [editingBusy, setEditingBusy] = useState(false);
  const connectionRef = useRef(null);
  useEffect(() => { onDirtyChange?.(editingDirty); return () => onDirtyChange?.(false); }, [editingDirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(editingBusy); return () => onBusyChange?.(false); }, [editingBusy, onBusyChange]);
  function selectConnection(id) {
    if (editingBusy || (editingDirty && !window.confirm('Discard unsaved credentials?'))) return;
    setSelection(id); setHelp(''); setEditingDirty(false);
    if (id) requestAnimationFrame(() => connectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }
  function receiveConnection(row) {
    setData(current => ({ ...current, connections: { ...current.connections, rows: [...(current.connections?.rows || []).filter(item => item.id !== row.id), row] } }));
  }
  useEffect(() => {
    if (!selection || editingBusy) return;
    const controller = new AbortController();
    api.get('/integrations', { signal: controller.signal }).then(connections => {
      if (!controller.signal.aborted) { setData(current => ({ ...current, connections })); setFailed(current => current.filter(key => key !== 'connections')); }
    }).catch(() => {});
    return () => controller.abort();
  }, [selection, editingBusy]);
  const canManage = permissions.includes('manageConnections');
  const canOutreach = permissions.includes('outreach');
  const canSearch = permissions.includes('editLeads');
  const canWorkspace = permissions.includes('manageWorkspace');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const requests = [['accounts', '/email/accounts'], ['whatsapp', '/whatsapp/inbox/settings'], ['verification', '/email/infrastructure'], ['sharing', '/publishing/status'], ['connections', '/integrations']];
    Promise.allSettled(requests.map(([, path]) => api.get(path, { signal: controller.signal }))).then(results => {
      if (controller.signal.aborted) return;
      const values = {}, errors = [];
      results.forEach((result, index) => { const key = requests[index][0]; if (result.status === 'fulfilled') values[key] = result.value; else errors.push(key); });
      setData(values); setFailed(errors); setLoading(false);
    });
    return () => controller.abort();
  }, [reload]);
  const email = provider => {
    const matches = (data.accounts?.rows || []).filter(account => account.provider === provider);
    return matches.find(account => account.verified) || matches.find(account => account.configured);
  };
  const mailCard = (id, name) => {
    const account = email(id);
    return { id, name, provider: id, description: id === 'smtp' ? 'Custom email server' : 'Email', status: statusFor(account, loading, failed.includes('accounts')), ready: Boolean(account?.verified), action: account?.configured ? 'Manage' : 'Connect', allowed: canManage && canOutreach, target: { view: 'email', section: 'mailboxes', provider: id } };
  };
  const cards = [
    { id: 'places', name: 'Google Places', provider: 'google', description: 'Find businesses', status: !meta ? 'Loading...' : meta.placesKeyConfigured ? 'Key configured' : 'Not connected', ready: Boolean(meta?.placesKeyConfigured), action: meta?.placesKeyConfigured ? 'Manage' : 'Connect', allowed: canManage || canWorkspace, help: 'places' },
    mailCard('gmail', 'Gmail'),
    mailCard('microsoft', 'Microsoft 365'),
    { id: 'personal', name: 'WhatsApp', provider: 'whatsapp', description: 'Personal chats', status: desktop ? 'Desktop available' : 'Desktop required', ready: false, action: desktop ? 'Open inbox' : 'Setup', allowed: canOutreach, ...(desktop ? { target: { view: 'whatsapp', section: 'inbox' } } : { help: 'personal' }) },
    { id: 'business', name: 'WhatsApp Business', provider: 'meta', description: 'Business messages', status: statusFor(data.whatsapp, loading, failed.includes('whatsapp')), ready: Boolean(data.whatsapp?.verified), action: data.whatsapp?.configured ? 'Manage' : 'Connect', allowed: canManage && canOutreach, target: { view: 'whatsapp', section: 'connection' }, secondary: data.whatsapp?.verified && canOutreach ? { label: 'Open inbox', target: { view: 'whatsapp', section: 'business-inbox' } } : null },
    { id: 'verification', name: 'ZeroBounce', provider: 'zerobounce', description: 'Verify email addresses', status: loading ? 'Loading...' : failed.includes('verification') ? 'Unavailable' : data.verification?.verifierConfigured ? 'Key saved' : 'Not connected', ready: false, action: data.verification?.verifierConfigured ? 'Manage' : 'Connect', allowed: canManage && canOutreach, target: { view: 'email', section: 'verification' } },
    ...INTEGRATIONS.map(provider => {
      const connection = data.connections?.rows?.find(row => row.id === provider.id);
      return { ...provider, provider: provider.id, connection: true, status: loading ? 'Loading...' : failed.includes('connections') ? 'Setup pending' : connection?.verified ? (data.connections?.simulated ? 'Verified (sample)' : 'Verified') : connection?.configured ? (data.connections?.simulated ? 'Saved (sample)' : 'Not verified') : 'Not connected', ready: Boolean(connection?.verified), action: connection?.configured ? 'Manage' : 'Connect', allowed: canManage, secondary: ['twilio','telnyx','vonage'].includes(provider.id) && canOutreach ? { label: 'Open SMS', target: { view: 'sms' } } : null };
    }),
    mailCard('smtp', 'SMTP'),
    { id: 'unsubscribe', name: 'Unsubscribe', icon: 'link', description: 'Email preferences', status: loading ? 'Loading...' : failed.includes('sharing') ? 'Unavailable' : data.sharing?.configured ? 'Connected' : 'Not connected', ready: Boolean(data.sharing?.configured), action: data.sharing?.configured ? 'Manage' : 'Connect', allowed: canWorkspace, target: { view: 'system' } },
  ];
  return <div className="page integrations-page">
    <PageHead title="Integrations"  />
    {failed.length > 0 && <div className="integration-error" role="alert"><span>Some statuses are unavailable</span><button className="btn ghost" onClick={() => setReload(value => value + 1)}>Retry</button></div>}
    {selection && <div ref={connectionRef}><IntegrationConnection key={selection} provider={INTEGRATIONS.find(provider => provider.id === selection)} connection={data.connections?.rows?.find(row => row.id === selection)} simulated={Boolean(meta?.qaSimulator || data.connections?.simulated)} unavailable={loading || failed.includes('connections')} onChanged={receiveConnection} onClose={() => selectConnection('')} onDirtyChange={setEditingDirty} onBusyChange={setEditingBusy} /></div>}
    <section className="integration-grid" aria-label="Available integrations">
      {cards.map(card => <article key={card.id} className="integration-card" aria-labelledby={`integration-${card.id}`}>
        <header><span className="integration-mark">{card.icon ? <Icon name={card.icon} size={25} /> : <ProviderIcon provider={card.provider} size={28} />}</span><h2 id={`integration-${card.id}`}>{card.name}</h2></header>
        <p>{card.description}</p>
        <span className={`integration-status ${card.ready ? 'ready' : ''}`}><i />{card.status}</span>
        <footer><button className="btn" disabled={!card.allowed || editingBusy} title={!card.allowed ? 'Ask a workspace administrator' : undefined} aria-label={`${card.action} ${card.name}`} aria-expanded={card.connection ? selection === card.id : card.help ? help === card.help : undefined} onClick={() => card.connection ? selectConnection(card.id) : card.help ? setHelp(value => value === card.help ? '' : card.help) : onOpen(card.target)}>{card.action}</button>{card.secondary && <button className="btn" onClick={() => onOpen(card.secondary.target)} aria-label={`${card.secondary.label} · ${card.name}`}>{card.secondary.label}</button>}</footer>
        {help === card.id && card.id === 'places' && <div className="integration-inline-setup"><p>Set the API key on your server, then restart Local Geni.</p><code>GOOGLE_PLACES_API_KEY</code><div className="preview-actions"><a className="btn" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer"><ProviderIcon provider="google" size={14} />Open Google</a>{canSearch && <button className="btn ghost" onClick={() => onOpen({ view: 'configure' })}>Find businesses</button>}</div><small>This screen never displays your key</small></div>}
        {help === card.id && card.id === 'personal' && <div className="integration-inline-setup"><p>Open Local Geni Desktop. Scan the QR code inside.</p><details className="integration-help"><summary>Launcher</summary><p>In the Local Geni project:</p><code>npm run desktop</code><p>On your phone: WhatsApp / Linked devices / Link a device</p></details><small>Real messages. Sign-in stays on this computer account.</small></div>}
      </article>)}
    </section>
  </div>;
}
