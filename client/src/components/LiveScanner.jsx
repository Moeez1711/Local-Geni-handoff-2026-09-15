import { useEffect, useState } from 'react';
import { api, fmt } from '../lib/api.js';
import MapView from './MapView.jsx';
import CoverageGrid from './CoverageGrid.jsx';
import { Empty, Kpi, Meter, PageHead, StatusChip } from './ui.jsx';

const RESUMABLE = ['paused', 'interrupted', 'stopped', 'failed', 'completed'];

export default function LiveScanner({ scan, scans, apiFeed, leadsVersion, onAction, onOpenScan, onOpenLead, onNew }) {
  const [points, setPoints] = useState([]);
  const [coverage, setCoverage] = useState([]);
  const [raise, setRaise] = useState({ targetCount: '', maxApiCalls: '' });

  useEffect(() => {
    if (!scan?.id) return undefined;
    const ctl = new AbortController();
    api.get(`/leads/map?scanId=${scan.id}`, { signal: ctl.signal }).then(setPoints).catch(() => {});
    return () => ctl.abort();
  }, [scan?.id, leadsVersion]);

  useEffect(() => {
    if (!scan?.id) return;
    const controller = new AbortController();
    api.get(`/scans/${scan.id}/coverage`, { signal: controller.signal }).then(setCoverage).catch(() => {});
    return () => controller.abort();
  }, [scan?.id, leadsVersion, scan?.status]);

  if (!scan) {
    return (
      <div className="page">
        <PageHead eyebrow="02 / Live scanner" title="No scan selected" />
        <Empty title="Nothing scanning yet">
          <p>Configure a search to start discovering businesses.</p>
          <button className="btn primary" onClick={onNew}>Configure a search</button>
        </Empty>
        <History scans={scans} onOpenScan={onOpenScan} onAction={onAction} />
      </div>
    );
  }

  const s = scan.stats;
  const c = scan.config;
  const targetValue = c.targetMode === 'qualified' ? s.qualified : s.discovered;
  const tilesLeft = s.tilesPending + s.tilesActive + s.tilesFailed;
  const canResume = !scan.active && RESUMABLE.includes(scan.status) && !(scan.status === 'completed' && tilesLeft === 0);
  const scanErrors = apiFeed.filter((a) => a.scanId === scan.id || a.scanId == null);

  return (
    <div className="page">
      <PageHead
        eyebrow={`02 / Live scanner / Scan #${scan.id} / started ${fmt.ago(scan.createdAt)}`}
        title={`${c.categoryLabel}${c.keywords ? ` / ${c.keywords}` : ''} in ${c.area}, ${c.countryName}`}
      >
        <StatusChip status={scan.active && scan.status !== 'running' ? 'running' : scan.status} />
        {scan.active && <button className="btn" onClick={() => onAction('pause', scan.id)}>Pause</button>}
        {scan.active && <button className="btn danger" onClick={() => onAction('stop', scan.id)}>Stop</button>}
        {canResume && (
          <button className="btn primary" onClick={() => onAction('resume', scan.id, {
            targetCount: raise.targetCount || undefined, maxApiCalls: raise.maxApiCalls || undefined,
          })}>Resume</button>
        )}
      </PageHead>

      {(scan.stats.note || scan.error) && (
        <div className={`banner ${scan.error ? 'error' : 'info'}`}>{scan.error || scan.stats.note}</div>
      )}

      {canResume && (
        <div className="card resume">
          <span>Raise limits before resuming <em className="muted">(optional)</em></span>
          {c.completionMode !== 'coverage' && <label className="field inline"><span>Target</span>
            <input type="number" placeholder={c.targetCount} value={raise.targetCount} onChange={(e) => setRaise({ ...raise, targetCount: e.target.value })} />
          </label>}
          <label className="field inline"><span>API budget</span>
            <input type="number" placeholder={c.maxApiCalls} value={raise.maxApiCalls} onChange={(e) => setRaise({ ...raise, maxApiCalls: e.target.value })} />
          </label>
          <span className="muted small">{fmt.num(tilesLeft)} search areas unfinished</span>
        </div>
      )}

      <div className="meters card">
        {c.completionMode === 'coverage' ? <Meter label="Boundary processed" value={Math.floor(s.coveragePercent || 0)} max={100} tone="accent" hint="Area coverage, not percentage of all businesses"/>
          : <Meter label={`Target (${c.targetMode === 'qualified' ? 'qualified leads' : 'businesses'})`} value={targetValue} max={c.targetCount} tone="accent" />}
        <Meter label="API request budget" value={s.billedCalls} max={c.maxApiCalls} tone={s.billedCalls / c.maxApiCalls > 0.85 ? 'warn' : ''}
          hint={`${fmt.num(s.cachedCalls)} served from cache / ${fmt.num(s.apiErrors)} errors`} />
        <Meter label="Search areas processed" value={s.areasDone ?? s.tilesDone} max={s.areasTotal ?? s.tilesTotal}
          hint={`Crowded areas split automatically${s.tilesFailed ? ` · ${s.tilesFailed} failed` : ''}${s.cappedAreas ? ` · ${s.cappedAreas} still capped` : ''}`} />
        <Meter label="Websites analysed" value={s.discovered - s.sitesPending} max={s.discovered} hint={s.sitesPending ? `${s.sitesPending} in queue` : 'Queue empty'} />
      </div>

      <div className="kpis">
        <Kpi label="Matching businesses" value={fmt.num(s.discovered)} sub={`${fmt.num(s.fresh)} new to database · ${fmt.num(s.excluded || 0)} excluded by area or filters`} />
        <Kpi label="Qualified" value={fmt.num(s.qualified)} sub="Hot + Potential" tone="accent" />
        <Kpi label="Hot leads" value={fmt.num(s.hot)} tone="hot" />
        <Kpi label="No / weak website" value={fmt.num(s.noSite)} sub="none / social only / broken" />
        <Kpi label="WhatsApp-ready" value={fmt.num(s.whatsapp)} sub="site link or mobile number" />
        <Kpi label="Duplicates skipped" value={fmt.num(s.duplicatesSkipped || 0)} sub="by Place ID / phone / domain" />
      </div>

      <div className="split">
        <section className="card map-card">
          <div className="card-head">
            <h3>Discovered businesses</h3>
            <span className="legend"><i className="pin pin-hot" />Hot <i className="pin pin-potential" />Potential <i className="pin pin-low" />Low</span>
          </div>
          <MapView bounds={scan.area?.bounds} circle={scan.area?.radiusKm ? { center: scan.area.center, radiusKm: scan.area.radiusKm } : null} points={points} onSelect={onOpenLead} height={320} />
          <CoverageGrid bounds={scan.area?.bounds} cells={coverage} radius={scan.area?.radiusKm ? { center: scan.area.center, radiusKm: scan.area.radiusKm } : null}/>
          <p className="hint">Each area is searched independently. Green means the query finished; it does not guarantee every business was returned.</p>
        </section>

        <section className="card feed">
          <div className="card-head"><h3>Activity</h3>{scan.active && <span className="live-dot">live</span>}</div>
          <ol className="log">
            {[...scan.logs].reverse().map((l, i) => (
              <li key={`${l.ts}-${i}`} className={l.level}><time>{fmt.time(l.ts)}</time>{l.message}</li>
            ))}
            {!scan.logs.length && <li className="muted">Log starts when the scan runs in this server session.</li>}
          </ol>
          <div className="card-head"><h3>API calls</h3><span className="muted small">this session</span></div>
          <ol className="log api">
            {scanErrors.slice(0, 25).map((a, i) => (
              <li key={`${a.ts}-${i}`} className={a.outcome}>
                <time>{fmt.time(a.ts)}</time>
                <b>{a.endpoint}</b> {a.outcome}{a.httpCode ? ` / ${a.httpCode}` : ''}{a.ms ? ` / ${a.ms} ms` : ''}{a.error ? ` / ${a.error}` : ''}
              </li>
            ))}
            {!scanErrors.length && <li className="muted">No API calls yet.</li>}
          </ol>
        </section>
      </div>

      <History scans={scans} currentId={scan.id} onOpenScan={onOpenScan} onAction={onAction} />
    </div>
  );
}

function History({ scans, currentId, onOpenScan, onAction }) {
  if (!scans.length) return null;
  return (
    <section className="card">
      <div className="card-head"><h3>Scan history</h3><span className="muted small">{scans.length} scans</span></div>
      <div className="table-wrap">
        <table className="table compact">
          <thead><tr><th>#</th><th>Search</th><th>Status</th><th className="r">Found</th><th className="r">Qualified</th><th className="r">API</th><th>When</th><th /></tr></thead>
          <tbody>
            {scans.map((s) => (
              <tr key={s.id} className={s.id === currentId ? 'current' : ''}>
                <td className="num">{s.id}</td>
                <td><button className="link" onClick={() => onOpenScan(s.id)}>{s.config.categoryLabel} / {s.config.area}, {s.config.country}</button></td>
                <td><StatusChip status={s.active ? 'running' : s.status} /></td>
                <td className="r num">{fmt.num(s.stats.discovered)}</td>
                <td className="r num">{fmt.num(s.stats.qualified)}</td>
                <td className="r num">{fmt.num(s.stats.billedCalls)}</td>
                <td className="muted">{fmt.ago(s.createdAt)}</td>
                <td className="r actions">
                  {!s.active && RESUMABLE.includes(s.status) && (s.stats.tilesPending + s.stats.tilesFailed) > 0 && <button className="btn xs" onClick={() => onAction('resume', s.id)}>Resume</button>}
                  {!s.active && <button className="btn xs ghost" onClick={() => window.confirm(`Delete scan #${s.id}? Leads stay in the database.`) && onAction('delete', s.id)}>Delete</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
