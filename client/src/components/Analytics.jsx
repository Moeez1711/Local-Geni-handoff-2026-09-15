import { useEffect, useState } from 'react';
import { api, fmt, qs, LEAD_STATUSES } from '../lib/api.js';
import { Bars, Icon, MetricStrip, PageHead } from './ui.jsx';

const WEB_LABELS = {
  none: 'No website', social_only: 'Social only', broken: 'Broken', site_outdated: 'Outdated site', site_dated: 'Dated site',
  site_modern: 'Modern site', pending: 'Pending check', analyzing: 'Analysing', unknown: 'Blocked / unchecked',
};
const WEB_TONES = { none: 'bad', social_only: 'bad', broken: 'bad', site_outdated: 'warn', site_dated: 'warn', site_modern: 'good' };
// Maps a web-presence bucket to the Lead Results filter that shows it.
const WEB_FILTER = { none: 'none', social_only: 'social_only', broken: 'broken', site_outdated: 'outdated', site_dated: 'outdated',
  site_modern: 'modern', site_unknown: 'pending', pending: 'pending', analyzing: 'pending', unknown: 'pending' };
const TIER_LABELS = { hot: 'Hot', potential: 'Potential', warm: 'Warm', low: 'Low' };

export default function Analytics({ scanId, leadsVersion, onOpen }) {
  const [scope, setScope] = useState('all');
  const [data, setData] = useState(null);

  useEffect(() => {
    const ctl = new AbortController();
    api.get(`/analytics${qs({ scanId: scope === 'scan' ? scanId : '' })}`, { signal: ctl.signal }).then(setData).catch(() => {});
    return () => ctl.abort();
  }, [scope, scanId, leadsVersion]);

  if (!data) return <div className="loading">Loading...</div>;
  const t = data.totals;
  const a = data.api;
  const maxDay = Math.max(1, ...a.daily.map((d) => d.billed + d.cached + d.errors));

  return (
    <div className="page analytics-page">
      <PageHead title="Pipeline & API usage" description="Track lead quality, outreach readiness, and search spend.">
        <div className="seg">
          <button className={scope === 'scan' ? 'on' : ''} disabled={!scanId} onClick={() => setScope('scan')}>This scan</button>
          <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All leads</button>
        </div>
      </PageHead>

      <MetricStrip className="analytics-lead-metrics" label="Lead totals" items={[
        { label: 'Businesses', value: fmt.num(t.total), icon: 'building' },
        { label: 'Hot', value: fmt.num(t.hot), icon: 'activity', tone: 'red' },
        { label: 'Potential', value: fmt.num(t.potential), icon: 'chart', tone: 'amber' },
        { label: 'Weak / no website', value: fmt.num(t.noSite), icon: 'globe', sub: `${t.total ? Math.round((t.noSite / t.total) * 100) : 0}% of businesses` },
        { label: 'WhatsApp-ready', value: fmt.num(t.whatsapp), icon: 'message', tone: 'green', sub: `${fmt.num(t.email)} with email` },
        { label: 'Average score', value: Math.round(t.avgScore || 0), icon: 'chart', tone: 'blue' },
      ]}/>

      <div className="grid-3">
        <section className="card"><div className="card-head"><h3>Lead tiers</h3></div><Bars rows={data.tiers} labels={TIER_LABELS} tones={{ hot: 'hot', potential: 'warn' }} onSelect={(k) => onOpen({ tier: [k] }, scope)} /></section>
        <section className="card"><div className="card-head"><h3>Web presence</h3></div><Bars rows={data.web} labels={WEB_LABELS} tones={WEB_TONES} onSelect={(k) => onOpen(WEB_FILTER[k] ? { web: [WEB_FILTER[k]] } : {}, scope)} /></section>
        <section className="card"><div className="card-head"><h3>Sales pipeline</h3></div><Bars rows={data.leadStatus} labels={Object.fromEntries(LEAD_STATUSES)} tones={{ converted: 'good', interested: 'accent' }} onSelect={(k) => onOpen({ leadStatus: k }, scope)} /></section>
        <section className="card">
          <div className="card-head"><h3>Top categories</h3><span title="Select a category to open its leads"><Icon name="arrowUpRight" size={16}/></span></div>
          <Bars rows={data.categories.filter((c) => c.k)} onSelect={(k) => onOpen({ category: k }, scope)} />
        </section>
        <section className="card"><div className="card-head"><h3>Google rating</h3></div><Bars rows={data.ratings} /></section>
        <section className="card analytics-queue">
          <div className="card-head"><h3>Website queue</h3></div>
          <p className="big num">{data.siteQueue.active}</p>
          <p className="muted small">{data.siteQueue.draining ? 'Queue active' : 'Queue idle'} · analyses running</p>
        </section>
      </div>

      <section className="card analytics-api">
        <div className="card-head"><h3><Icon name="activity" size={17}/>Google Places API usage</h3><span className="muted small">All scans</span></div>
        <MetricStrip label="Google Places API totals" items={[
          { label: 'Billed today', value: fmt.num(a.today.billed), icon: 'calendar', sub: `${fmt.num(a.today.cached)} cached · ${fmt.num(a.today.errors)} errors` },
          { label: 'Billed this month', value: fmt.num(a.month.billed), icon: 'activity', sub: `${fmt.num(a.month.cached)} cached` },
          { label: 'Est. monthly cost', value: `$${data.usage.estMonthCostUsd.toFixed(2)}`, icon: 'chart', tone: 'green', sub: `${fmt.num(data.usage.freeLeftThisMonth)} free searches left` },
          { label: 'Errors this month', value: fmt.num(a.month.errors), icon: 'alert', tone: a.month.errors ? 'red' : '' },
        ]}/>
        <div className={`daily ${!a.daily.length ? 'daily-empty' : ''}`}>
          {a.daily.map((d) => (
            <div key={d.d} className="day" title={`${d.d}: ${d.billed} billed, ${d.cached} cached, ${d.errors} errors`}>
              <div className="day-stack" style={{ height: `${((d.billed + d.cached + d.errors) / maxDay) * 100}%` }}>
                <i className="e" style={{ flex: d.errors }} /><i className="c" style={{ flex: d.cached }} /><i className="b" style={{ flex: d.billed }} />
              </div>
              <small>{d.d.slice(5)}</small>
            </div>
          ))}
          {!a.daily.length && <p className="muted small">No API calls in the last 14 days.</p>}
        </div>
        <p className="hint">Estimates from this app. Check Google Cloud billing for final charges.</p>
        {a.recentErrors.length > 0 && (
          <div className="table-wrap">
            <table className="table compact">
              <thead><tr><th>When</th><th>Scan</th><th>Endpoint</th><th>HTTP</th><th>Error</th></tr></thead>
              <tbody>
                {a.recentErrors.map((e, i) => (
                  <tr key={i}><td>{fmt.ago(e.ts)}</td><td className="num">{e.scan_id ?? '-'}</td><td>{e.endpoint}</td><td className="num">{e.http_code ?? '-'}</td><td className="bad">{e.error}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
