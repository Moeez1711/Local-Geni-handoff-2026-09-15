import { useEffect, useState } from 'react';
import { api, fmt } from '../lib/api.js';
import { Icon, PageHead } from './ui.jsx';

export default function FollowUpsWorkspace({ leadsVersion, onOpenLead, onOpenLeads }) {
  const [scope, setScope] = useState('due');
  const [query, setQuery] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    const timer = setTimeout(() => {
      api.get(`/leads?followUp=${scope}&sort=followup&dir=asc&limit=100&q=${encodeURIComponent(query.trim())}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setData(result); }).catch(err => { if (!controller.signal.aborted) setError(err.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, query ? 200 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [scope, query, leadsVersion, reload]);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return <div className="page followups-page"><PageHead title="Follow-ups"><button className="btn" onClick={onOpenLeads}>View leads</button></PageHead>
    <div className="followups-toolbar"><label className="followups-search"><Icon name="search" size={16} /><input type="search" aria-label="Search follow-ups" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search businesses" /></label><nav aria-label="Follow-up view">{[['due', 'Due'], ['scheduled', 'All scheduled']].map(([key, label]) => <button key={key} aria-pressed={scope === key} onClick={() => setScope(key)}>{label}</button>)}</nav></div>
    {error ? <div className="dashboard-empty" role="alert"><p>Follow-ups could not load</p><button className="btn" onClick={() => setReload(value => value + 1)}>Retry</button></div> : loading ? <p className="dashboard-empty" role="status">Loading follow-ups...</p> : data?.rows?.length ? <><div className="followups-list">{data.rows.map(lead => {
      const overdue = lead.follow_up_at < today.getTime();
      return <article key={lead.place_id}><span className={`followup-date ${overdue ? 'overdue' : ''}`}><Icon name="calendar" size={18} /><time dateTime={new Date(lead.follow_up_at).toISOString()}>{new Date(lead.follow_up_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</time><small>{overdue ? 'Overdue' : new Date(lead.follow_up_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small></span><button className="followup-business" onClick={() => onOpenLead(lead.place_id)}><strong>{lead.name}</strong><span>{lead.category || lead.address || 'Business'}</span>{lead.notes && <p>{lead.notes}</p>}</button><button className="btn" onClick={() => onOpenLead(lead.place_id)}>Open</button></article>;
    })}</div><footer className="followups-count">{fmt.num(data.rows.length)} of {fmt.num(data.total)} scheduled {data.total === 1 ? 'follow-up' : 'follow-ups'}{data.total > data.rows.length && <button className="btn ghost" onClick={onOpenLeads}>View all</button>}</footer></> : <div className="dashboard-empty"><Icon name="calendar" size={24} /><h2>{query ? 'No matching follow-ups' : scope === 'due' ? 'No follow-ups due' : 'No follow-ups scheduled'}</h2><button className="btn" onClick={query ? () => setQuery('') : scope === 'due' ? () => setScope('scheduled') : onOpenLeads}>{query ? 'Clear search' : scope === 'due' ? 'View schedule' : 'Open leads'}</button></div>}
  </div>;
}
