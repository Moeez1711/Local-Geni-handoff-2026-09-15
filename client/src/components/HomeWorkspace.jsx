import { useEffect, useState } from 'react';
import { api, fmt } from '../lib/api.js';
import { Badge, Icon, PageHead, TierPill } from './ui.jsx';
import ProviderIcon from './ProviderIcon.jsx';

function ConnectionValue({ loading, error, tone = 'neutral', children }) {
  const resolvedTone = loading ? 'neutral' : error ? 'danger' : tone;
  const value = loading ? 'Loading…' : error ? 'Unavailable' : children;
  return <Badge tone={resolvedTone} className="connection-value">{value}</Badge>;
}

export default function HomeWorkspace({ leadsVersion, onNavigate, onOpenLeads, onOpenLead, followUps, canEdit, canOutreach, simulated }) {
  const [data, setData] = useState({});
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const requests = [
      ['leads', '/leads?limit=1'],
      ['priority', '/leads?limit=5&tier=hot&leadStatus=not_contacted'],
      ['uncontacted', '/leads?limit=1&leadStatus=not_contacted'],
      ['accounts', '/email/accounts'],
      ['sharing', '/publishing/status'],
      ['whatsapp', '/whatsapp/inbox/settings'],
    ];
    Promise.allSettled(requests.map(([, url]) => api.get(url, { signal: controller.signal }))).then(results => {
      if (controller.signal.aborted) return;
      const values = {}, failed = [];
      results.forEach((result, index) => {
        const key = requests[index][0];
        if (result.status === 'fulfilled') values[key] = result.value;
        else failed.push(key);
      });
      setData(values); setErrors(failed); setLoading(false);
    });
    return () => controller.abort();
  }, [leadsVersion, reload]);
  const accounts = data.accounts?.rows?.filter(account => account.configured) || [];
  const verifiedAccounts = accounts.filter(account => account.verified);
  const number = value => loading ? '...' : value == null ? 'Unavailable' : fmt.num(value);
  const priorityTotal = data.priority?.total;
  const actions = [];
  if (followUps?.due > 0) actions.push({ icon: 'calendar', title: 'Follow-ups due', detail: 'Start with the oldest due date', action: 'Review', view: 'followups' });
  if (canOutreach && data.accounts && !accounts.length) actions.push({ icon: 'message', title: 'Connect your mailbox', detail: 'Add a sender before reaching out', action: 'Connect', view: 'integrations' });
  if (canOutreach && data.sharing && !data.sharing.configured) actions.push({ icon: 'link', title: 'Finish email setup', detail: 'Connect an unsubscribe link for your recipients', action: 'Connect', view: 'system' });
  if (data.priority?.total > 0) actions.push({ icon: 'leads', title: 'Review your priority leads', detail: 'Start with the strongest matches you have not contacted', action: 'Review', view: 'leads' });
  if (data.leads?.total === 0 && canEdit) actions.push({ icon: 'search', title: 'Start your first search', detail: 'Choose a business type and neighbourhood', action: 'Find businesses', view: 'configure' });
  return <div className="page home-page">
    <PageHead eyebrow="Overview" title="Dashboard" description="See your pipeline, priorities, and setup at a glance." />
    <section className="dashboard-welcome" aria-labelledby="dashboard-welcome-heading" aria-describedby="dashboard-welcome-copy" aria-busy={loading}>
      <div className="dashboard-welcome-copy"><span className="dashboard-welcome-label"><Icon name="compass" size={15}/>Local growth workspace</span><h2 id="dashboard-welcome-heading">Your next conversation<br/>starts here.</h2><p id="dashboard-welcome-copy">{!loading && priorityTotal > 0 ? `${fmt.num(priorityTotal)} priority ${priorityTotal === 1 ? 'business is' : 'businesses are'} waiting for a first conversation. Start with the strongest matches.` : 'Discover local businesses, find the right fit, and turn your shortlist into conversations.'}</p><div className="dashboard-welcome-actions">{canEdit && <button type="button" className="btn primary" onClick={() => onNavigate('configure')}><Icon name="search" size={16}/>Find businesses<Icon name="arrowUpRight" size={16}/></button>}<button type="button" className="btn" onClick={() => onOpenLeads({})}><Icon name="leads" size={16}/>Explore your leads</button></div></div>
      <div className="dashboard-neighbourhood" aria-hidden="true"><div className="neighbourhood-ring ring-one"/><div className="neighbourhood-ring ring-two"/><div className="neighbourhood-route route-one"/><div className="neighbourhood-route route-two"/><span className="neighbourhood-pin pin-main"><Icon name="map" size={30}/></span><span className="neighbourhood-pin pin-shop"><Icon name="building" size={24}/></span><span className="neighbourhood-pin pin-chat"><Icon name="message" size={22}/></span><span className="neighbourhood-dot dot-one"/><span className="neighbourhood-dot dot-two"/><span className="neighbourhood-dot dot-three"/></div>
    </section>
    {errors.length > 0 && <div className="dashboard-error" role="alert"><Icon name="alert" size={16} /><span>Some workspace data could not load</span><button type="button" className="btn ghost" onClick={() => setReload(value => value + 1)}>Retry</button></div>}
    <section className="dashboard-metrics" aria-label="Workspace summary" aria-busy={loading}>
      {[
        { label: 'Businesses', value: data.leads?.total, icon: 'building', tone: 'teal', detail: 'In your workspace', view: 'leads', filters: {} },
        { label: 'Not contacted', value: data.uncontacted?.total, icon: 'message', tone: 'blue', detail: 'Awaiting a first conversation', view: 'leads', filters: { leadStatus: 'not_contacted' } },
        { label: 'Priority leads', value: data.priority?.total, icon: 'sparkles', tone: 'amber', detail: 'Uncontacted opportunities', view: 'leads', filters: { tier: ['hot'], leadStatus: 'not_contacted' } },
        { label: 'Follow-ups due', value: followUps?.due, icon: 'calendar', tone: 'violet', detail: 'Keep conversations moving', view: 'followups' },
      ].map(metric => <button type="button" key={metric.label} className={`dashboard-metric ${metric.tone}`} onClick={() => metric.filters ? onOpenLeads(metric.filters) : onNavigate(metric.view)} aria-label={loading ? `${metric.label}, loading` : `View ${metric.label.toLowerCase()}: ${number(metric.value)}`}><span className="dashboard-metric-top"><span className="dashboard-metric-icon"><Icon name={metric.icon} size={18}/></span><span>{metric.label}</span><Icon name="arrowUpRight" size={14}/></span><strong className={!loading && metric.value == null ? 'unavailable' : undefined}>{loading ? <><span className="dashboard-skeleton dashboard-skeleton-value" aria-hidden="true"/><span className="sr-only">Loading</span></> : number(metric.value)}</strong><small>{metric.detail}</small></button>)}
    </section>
    <div className="dashboard-grid">
      <section className="dashboard-attention" aria-labelledby="dashboard-next-steps-heading" aria-busy={loading}><header><Icon name="compass" size={18} /><h2 id="dashboard-next-steps-heading">Your next steps</h2></header>
        {loading ? <p className="dashboard-empty" role="status">Loading next actions…</p> : actions.length ? <div className="dashboard-action-list">{actions.map(item => <div key={item.title}><span className={`dashboard-action-icon ${item.view === 'leads' ? 'opportunity' : ''}`}><Icon name={item.icon} size={18} /></span><div><h3>{item.title}</h3><p>{item.detail}</p></div><button type="button" className="btn" onClick={() => item.view === 'leads' ? onOpenLeads({ tier: ['hot'], leadStatus: 'not_contacted' }) : onNavigate(item.view)}>{item.action}</button></div>)}</div> : <p className="dashboard-empty">{errors.length ? 'Refresh to see your next actions' : 'Nothing needs attention'}</p>}
      </section>
      <section className="dashboard-connections" aria-labelledby="dashboard-connections-heading" aria-busy={loading}><header><Icon name="plug" size={18} /><h2 id="dashboard-connections-heading">Your connections</h2></header>
        <dl>
          <div><dt>Mailboxes</dt><dd><ConnectionValue loading={loading} error={errors.includes('accounts')} tone={verifiedAccounts.length ? 'success' : 'warning'}>{verifiedAccounts.length ? `${verifiedAccounts.length} verified` : accounts.length ? `${accounts.length} saved` : 'Not connected'}</ConnectionValue></dd></div>
          <div><dt>Unsubscribe links</dt><dd><ConnectionValue loading={loading} error={errors.includes('sharing')} tone={data.sharing?.configured ? 'success' : 'warning'}>{data.sharing?.configured ? 'Configured' : 'Not connected'}</ConnectionValue></dd></div>
          <div><dt className="provider-label"><ProviderIcon provider="whatsapp" size={16} />WhatsApp Business</dt><dd><ConnectionValue loading={loading} error={errors.includes('whatsapp')} tone={data.whatsapp?.verified ? 'success' : data.whatsapp?.configured ? 'warning' : 'neutral'}>{data.whatsapp?.verified ? 'Verified' : data.whatsapp?.configured ? 'Verify' : 'Not connected'}</ConnectionValue></dd></div>
          <div><dt>Webhook</dt><dd><ConnectionValue loading={loading} error={errors.includes('whatsapp')} tone={data.whatsapp?.lastWebhookAt ? 'success' : data.whatsapp?.webhookConfigured ? 'warning' : 'neutral'}>{data.whatsapp?.lastWebhookAt ? 'Received' : data.whatsapp?.webhookConfigured ? 'Waiting' : 'Not connected'}</ConnectionValue></dd></div>
        </dl>
        {simulated && <p className="dashboard-mode-note">API sandbox. Personal WhatsApp is real.</p>}
        {canOutreach && <div className="dashboard-connection-actions"><button type="button" className="btn ghost" onClick={() => onNavigate('integrations')}>Manage integrations <Icon name="arrowUpRight" size={14} /></button></div>}
      </section>
    </div>
    <section className="dashboard-shortlist" aria-labelledby="dashboard-shortlist-heading" aria-busy={loading}><header><Icon name="leads" size={18} /><h2 id="dashboard-shortlist-heading">Priority shortlist</h2>{!loading && data.priority?.total > 0 && <span className="dashboard-shortlist-count">{fmt.num(data.priority.total)} uncontacted</span>}<button type="button" className="btn ghost" onClick={() => onOpenLeads({})}>View leads <Icon name="arrowUpRight" size={14} /></button></header>
      {loading ? <p className="dashboard-empty" role="status">Loading businesses…</p> : errors.includes('priority') ? <p className="dashboard-empty">Priority leads could not load</p> : data.priority?.rows?.length ? <div className="home-lead-list">{data.priority.rows.map(lead => <div key={lead.place_id}><button type="button" className="home-lead-name" onClick={() => onOpenLead(lead.place_id)}><span className="shortlist-avatar"><Icon name="building" size={20}/></span><span className="shortlist-identity"><strong>{lead.name}</strong><small>{[lead.category, lead.address].filter(Boolean).join(' / ')}</small></span></button><TierPill tier={lead.tier} score={lead.score} /></div>)}</div> : <div className="dashboard-empty"><p>No uncontacted priority leads</p>{canEdit && <button type="button" className="btn" onClick={() => onNavigate('configure')}>Find businesses</button>}</div>}
    </section>

  </div>;
}
