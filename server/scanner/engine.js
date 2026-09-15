/**
 * Scan engine: contiguous grid, then adaptive subdivision of crowded cells.
 * Each tile runs one text query restricted to its rectangle. Google returns at most 60 results per
 * query, so a saturated tile is split into 4 children and scanned again — this keeps discovering
 * businesses across the whole area instead of stopping at the first 60.
 * All progress lives in SQLite, so pause/resume and crash recovery just continue pending tiles.
 */
import { db, json, tx } from '../db.js';
import { emit } from '../events.js';
import { getSource } from '../providers/index.js';
import * as repo from '../repo.js';
import { countries, countryName } from '../catalog.js';
import { categoryCatalog, categoryLocale } from '../categoryCatalog.js';
import { kickSites } from '../enrich/siteQueue.js';
import { sleep } from '../util.js';
import { assertSearchAllowed, getLimits } from '../limits.js';
import { buildSearchPlan, validBounds, radiusBounds, insideSearchArea, normalizeLeadFilters, leadFilterReason } from '../../shared/searchPlan.js';

const TILE_WORKERS = 2;
const MIN_TILE_KM = 0.125;
const MAX_DEPTH = 9;
const MAX_TILES = 20000;
const MAX_TILE_ATTEMPTS = 3;

const running = new Map(); // scanId -> { intent: 'run'|'pause'|'stop'|'shutdown', controller, promise }
let creating = false;
const logs = new Map(); // scanId -> recent log lines (memory only)

const httpError = (status, message) => Object.assign(new Error(message), { status });

function log(scanId, level, message) {
  const line = { ts: Date.now(), level, message };
  const arr = logs.get(scanId) || [];
  arr.push(line);
  if (arr.length > 200) arr.shift();
  logs.set(scanId, arr);
  emit('scan:log', { scanId, ...line });
}

function setStatus(id, status, { error = null, note } = {}) {
  const row = db.prepare('SELECT stats FROM scans WHERE id=?').get(id);
  const stats = { ...json(row?.stats, {}), ...(note !== undefined ? { note } : {}) };
  db.prepare('UPDATE scans SET status=?, error=?, stats=?, updated_at=? WHERE id=?').run(status, error, JSON.stringify(stats), Date.now(), id);
  emit('scan:status', { scanId: id, status, error, note: stats.note });
}

export function getScan(id) {
  const row = db.prepare('SELECT * FROM scans WHERE id=?').get(Number(id));
  if (!row) return null;
  return {
    id: row.id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, error: row.error,
    config: json(row.config), area: json(row.area), stats: { ...json(row.stats, {}), ...repo.scanStats(row.id) },
    active: running.has(row.id), logs: logs.get(row.id) || [],
  };
}

export const listScans = () => db.prepare('SELECT id FROM scans ORDER BY id DESC LIMIT 200').all()
  .map(({ id }) => { const s = getScan(id); delete s.logs; return s; });

function normalizeInput(body = {}) {
  const country = String(body.country || '').toUpperCase();
  if (!countries.some((c) => c.code === country)) throw httpError(400, 'Choose a valid country');
  const area = String(body.area || '').trim();
  if (!area) throw httpError(400, 'Enter a city, area or neighbourhood');
  const language = categoryLocale(country, body.language || 'en').language;
  const cat = categoryCatalog.resolve(body.categoryId, country, language);
  const custom = String(body.customCategory || '').trim();
  if (!cat && !custom) throw httpError(400, 'Choose or type a business category');
  const keywords = String(body.keywords || '').trim().slice(0, 100);
  const clamp = (val, lo, hi, d) => Math.min(hi, Math.max(lo, Number(val) || d));
  const lim = getLimits();
  const categoryQuery = cat ? cat.query : custom;
  return {
    source: 'google_places',
    country, countryName: countryName(country), area,
    categoryId: cat?.id || null, categoryLabel: cat?.label || custom, categoryValue: cat?.value || 'medium', language,
    keywords, textQuery: [categoryQuery, keywords].filter(Boolean).join(' '),
    targetCount: clamp(body.targetCount, 1, 5000, lim.defaultTargetCount),
    targetMode: body.targetMode === 'qualified' ? 'qualified' : 'discovered',
    maxApiCalls: clamp(body.maxApiCalls, 1, 10000, lim.defaultScanBudget),
    radiusKm: clamp(body.radiusKm, 0.5, 50, 1),
    cellKm: clamp(body.cellKm, 0.5, 5, 1),
    coverageMode: body.coverageMode === 'radius' ? 'radius' : 'area',
    completionMode: body.completionMode === 'target' ? 'target' : 'coverage',
    filters: normalizeLeadFilters(body.filters),
  };
}

async function resolveSearchArea(cfg, customBounds, customCenter) {
  let area;
  if (customCenter && cfg.coverageMode === 'radius') {
    // Pin the centre the user just previewed; a second geocoder result must not move the search.
    const center = { lat: customCenter.lat, lng: customCenter.lng };
    area = { name: cfg.area, bounds: radiusBounds(center, cfg.radiusKm), center, radiusKm: cfg.radiusKm, custom: true };
  } else if (customBounds && cfg.coverageMode !== 'radius') {
    const bounds = validBounds(customBounds);
    area = { name: cfg.area, bounds, center: { lat: (bounds.south + bounds.north) / 2, lng: (bounds.west + bounds.east) / 2 }, custom: true };
  } else {
    area = await getSource(cfg.source).resolveArea({ area: cfg.area, countryName: cfg.countryName, regionCode: cfg.country, radiusKm: cfg.radiusKm, coverageMode: cfg.coverageMode });
    // Apply radius here too so every source honours the requested distance.
    if (cfg.coverageMode === 'radius') area = { ...area, bounds: radiusBounds(area.center, cfg.radiusKm), radiusKm: cfg.radiusKm };
  }
  area.bounds = validBounds(area.bounds);
  const { cells, ...plan } = buildSearchPlan(area.bounds, cfg.cellKm);
  return { area: { ...area, plan }, cells };
}

export async function previewArea(body) {
  const cfg = normalizeInput({ ...body, customCategory: body.customCategory || 'preview' });
  return (await resolveSearchArea(cfg, body.bounds)).area;
}

export async function createScan(body) {
  if (running.size || creating) throw httpError(409, 'Another scan is already starting or running. Pause or stop it first.');
  const cfg = normalizeInput(body);
  assertSearchAllowed();
  creating = true;
  try {
  const { area, cells } = await resolveSearchArea(cfg, body.bounds, body.center);
  const now = Date.now();
  const id = tx(() => {
    const { lastInsertRowid } = db.prepare('INSERT INTO scans (created_at, updated_at, status, config, area) VALUES (?,?,?,?,?)')
      .run(now, now, 'queued', JSON.stringify(cfg), JSON.stringify(area));
    const insert = db.prepare('INSERT INTO tiles (scan_id, south, west, north, east, depth) VALUES (?,?,?,?,?,0)');
    for (const b of cells) insert.run(lastInsertRowid, b.south, b.west, b.north, b.east);
    return Number(lastInsertRowid);
  });
  log(id, 'info', `Scan created: "${cfg.textQuery}" in ${area.name}, ${cfg.countryName}`);
  log(id, 'info', `${cells.length} search areas planned, up to ${cfg.cellKm} km across. Dense areas will be subdivided.`);
  startRun(id);
  return getScan(id);
  } finally { creating = false; }
}

export function resumeScan(id, body = {}) {
  id = Number(id);
  const scan = getScan(id);
  if (!scan) throw httpError(404, 'Scan not found');
  if (running.has(id)) throw httpError(409, 'Scan is already running');
  if (running.size || creating) throw httpError(409, 'Another scan is already starting or running');
  assertSearchAllowed();
  const cfg = scan.config;
  for (const [key, max] of [['targetCount', 5000], ['maxApiCalls', 10000]]) {
    if (body[key] != null) {
      const n = Number(body[key]);
      if (!Number.isInteger(n) || n < 1 || n > max) throw httpError(400, `Choose a valid ${key === 'targetCount' ? 'lead target' : 'request budget'}.`);
      cfg[key] = n;
    }
  }
  db.prepare('UPDATE scans SET config=? WHERE id=?').run(JSON.stringify(cfg), id);
  db.prepare(`UPDATE tiles SET status='pending', attempts=0 WHERE scan_id=? AND status='failed'`).run(id);
  log(id, 'info', `Resuming (target ${cfg.targetCount} ${cfg.targetMode}, budget ${cfg.maxApiCalls} requests)`);
  startRun(id);
  return getScan(id);
}

export function pauseScan(id) {
  const r = running.get(Number(id));
  if (!r) throw httpError(409, 'Scan is not running');
  r.intent = 'pause';
  log(Number(id), 'info', 'Pausing after in-flight requests finish…');
  return getScan(id);
}

export function stopScan(id) {
  id = Number(id);
  const r = running.get(id);
  if (r) { r.intent = 'stop'; r.controller.abort(); log(id, 'info', 'Stopping…'); }
  else if (getScan(id)) setStatus(id, 'stopped');
  else throw httpError(404, 'Scan not found');
  return getScan(id);
}

export function deleteScan(id) {
  id = Number(id);
  if (running.has(id)) throw httpError(409, 'Stop the scan before deleting it');
  db.prepare('DELETE FROM scans WHERE id=?').run(id);
  logs.delete(id);
}

export async function shutdown() {
  for (const r of running.values()) { r.intent = 'shutdown'; r.controller.abort(); }
  await Promise.race([Promise.allSettled([...running.values()].map((r) => r.promise)), sleep(3000)]);
}

function startRun(id) {
  const ctl = { intent: 'run', controller: new AbortController() };
  running.set(id, ctl);
  db.prepare(`UPDATE tiles SET status='pending' WHERE scan_id=? AND status='active'`).run(id);
  setStatus(id, 'running', { note: null });
  ctl.promise = runScan(id, ctl)
    .catch((e) => { log(id, 'error', e.message); setStatus(id, 'failed', { error: e.message }); })
    .finally(() => { running.delete(id); emitProgress(id, true); kickSites(); });
}

const claimStmt = db.prepare(`SELECT * FROM tiles WHERE scan_id=? AND status='pending' ORDER BY depth, id LIMIT 1`);
const markActive = db.prepare(`UPDATE tiles SET status='active' WHERE id=?`);
const insertTile = db.prepare('INSERT INTO tiles (scan_id, south, west, north, east, depth, parent_id) VALUES (?,?,?,?,?,?,?)');
const claimTile = (scanId) => tx(() => { const t = claimStmt.get(scanId); if (t) markActive.run(t.id); return t; });

function splitTile(scanId, t) {
  const heightKm = (t.north - t.south) * 110.574;
  const widthKm = (t.east - t.west) * 111.32 * Math.cos((t.north + t.south) / 2 * Math.PI / 180);
  if (t.depth >= MAX_DEPTH || Math.min(heightKm, widthKm) / 2 < MIN_TILE_KM || db.prepare('SELECT COUNT(*) n FROM tiles WHERE scan_id=?').get(scanId).n + 4 > MAX_TILES) return false;
  const midLat = (t.south + t.north) / 2;
  const midLng = (t.west + t.east) / 2;
  for (const [s, w, n, e] of [[t.south, t.west, midLat, midLng], [t.south, midLng, midLat, t.east], [midLat, t.west, t.north, midLng], [midLat, midLng, t.north, t.east]]) {
    insertTile.run(scanId, s, w, n, e, t.depth + 1, t.id);
  }
  return true;
}

const lastEmit = new Map();
function emitProgress(id, force = false) {
  const now = Date.now();
  if (!force && now - (lastEmit.get(id) || 0) < 400) return;
  lastEmit.set(id, now);
  emit('scan:progress', { scanId: id, status: getScan(id)?.status, stats: repo.scanStats(id), active: running.has(id) });
}

async function runScan(id, ctl) {
  const { config: cfg, area } = getScan(id);
  const source = getSource(cfg.source);
  const { signal } = ctl.controller;
  let finishReason = null;
  let fatal = null;
  let limitHit = null;
  let dupTotal = 0;
  const halted = () => ctl.intent !== 'run' || finishReason || fatal || limitHit;

  const checkLimits = () => {
    const s = repo.scanStats(id);
    const count = cfg.targetMode === 'qualified' ? s.qualified : s.discovered;
    if (cfg.completionMode !== 'coverage' && count >= cfg.targetCount) finishReason = `Target reached: ${count} ${cfg.targetMode === 'qualified' ? 'qualified leads' : 'businesses'}. Remaining search areas can be resumed with a higher target.`;
    return s;
  };

  async function worker() {
    while (!halted()) {
      checkLimits();
      if (halted()) break;
      const tile = claimTile(id);
      if (!tile) {
        if (repo.scanStats(id).tilesActive === 0) { finishReason ||= 'All planned search areas processed'; break; }
        await sleep(250, signal);
        continue;
      }
      try {
        let streamed = false;
        const savePage = (page) => {
          streamed = true;
          let fresh = 0, dup = 0, split = false;
          tx(() => {
            for (const p of page.places) {
              if (!p.sourceId) continue;
              let reason = insideSearchArea(p, area) ? leadFilterReason(p, cfg.filters || normalizeLeadFilters({ status: 'any' })) : 'outside_area';
              const existing = repo.existingPlace(p, cfg.country);
              if (existing?.deleted_at != null) reason = 'trashed';
              if (!reason && cfg.filters?.newOnly && existing && !linkedToScan.get(id, existing.place_id)) reason = 'already_saved';
              if (!reason) {
                const r = repo.upsertPlace(p, { scanId: id, countryCode: cfg.country, categoryValue: cfg.categoryValue });
                if (r.linked) fresh++; else dup++;
              }
              saveCandidate.run(id, p.sourceId, reason);
            }
            if (page.complete && page.saturated) split = splitTile(id, tile);
            db.prepare(`UPDATE tiles SET status=?, page_token=?, pages=?, results=?, saturated=?, error=NULL WHERE id=?`)
              .run(page.complete ? 'done' : 'active', page.complete ? null : page.nextPageToken, page.pages, page.resultCount, page.saturated && !split ? 1 : 0, tile.id);
          });
          dupTotal += dup;
          log(id, 'info', `Area ${tile.id}, page ${page.pages}: ${fresh} added, ${dup} duplicates${split ? ' · crowded area split into four' : ''}`);
          if (fresh) kickSites();
          emitProgress(id);
        };
        const res = await source.searchArea({ textQuery: cfg.textQuery, bounds: tile, regionCode: cfg.country, languageCode: cfg.language || 'en' }, {
          scanId: id, signal, maxApiCalls: cfg.maxApiCalls, pageToken: tile.page_token, pages: tile.pages, resultCount: tile.results,
          shouldPause: () => { checkLimits(); return Boolean(halted()); }, onPage: savePage,
        });
        if (!streamed) savePage({ ...res, resultCount: res.places.length, complete: true });
      } catch (e) {
        if (e.code === 'LIMIT') {
          db.prepare(`UPDATE tiles SET status='pending' WHERE id=?`).run(tile.id);
          limitHit = e;
          break;
        }
        if (e.code === 'ABORTED' || signal.aborted) {
          db.prepare(`UPDATE tiles SET status='pending' WHERE id=?`).run(tile.id);
          break;
        }
        const attempts = tile.attempts + 1;
        const failed = e.fatal || attempts >= MAX_TILE_ATTEMPTS;
        db.prepare('UPDATE tiles SET status=?, attempts=?, error=? WHERE id=?').run(failed ? 'failed' : 'pending', attempts, e.message, tile.id);
        // Google page tokens can expire while a scan is paused. Replay this area; place IDs deduplicate saved pages.
        if (tile.page_token && e.status === 400) db.prepare('UPDATE tiles SET page_token=NULL, pages=0, results=0 WHERE id=?').run(tile.id);
        log(id, 'error', `Tile ${tile.id}: ${e.message}${failed ? '' : ' (will retry)'}`);
        if (e.fatal) fatal = e;
        else await sleep(2000, signal);
      }
      emitProgress(id);
    }
  }

  await Promise.all(Array.from({ length: TILE_WORKERS }, worker));

  const prev = json(db.prepare('SELECT stats FROM scans WHERE id=?').get(id).stats, {});
  db.prepare('UPDATE scans SET stats=? WHERE id=?').run(JSON.stringify({ ...prev, duplicatesSkipped: (prev.duplicatesSkipped || 0) + dupTotal }), id);

  if (fatal) { setStatus(id, 'failed', { error: fatal.message }); return; }
  if (limitHit) { log(id, 'error', limitHit.message); setStatus(id, 'paused', { note: limitHit.message }); return; }
  const endStatus = { pause: 'paused', stop: 'stopped', shutdown: 'interrupted' }[ctl.intent];
  if (endStatus) { setStatus(id, endStatus); log(id, 'info', `Scan ${endStatus}`); return; }
  const finalStats = repo.scanStats(id);
  const incomplete = finalStats.tilesPending + finalStats.tilesFailed + finalStats.tilesActive > 0;
  const status = incomplete ? 'paused' : 'completed';
  const note = finalStats.tilesFailed ? `${finalStats.tilesFailed} search areas failed. Resume to retry them.`
    : `${finishReason || 'Search finished'}.${finalStats.cappedAreas ? ` ${finalStats.cappedAreas} crowded areas still reached Google's result cap.` : ''} Google results are not an exhaustive business directory.`;
  setStatus(id, status, { note });
  log(id, 'info', note);
}

const linkedToScan = db.prepare('SELECT 1 FROM scan_businesses WHERE scan_id=? AND place_id=?');
const saveCandidate = db.prepare(`INSERT INTO scan_candidates(scan_id, source_id, reason) VALUES(?,?,?)
  ON CONFLICT(scan_id, source_id) DO UPDATE SET reason=excluded.reason`);

export function scanCoverage(id) {
  if (!getScan(id)) throw httpError(404, 'Scan not found');
  return db.prepare(`SELECT id, south, west, north, east, status, saturated FROM tiles t WHERE scan_id=?
    AND NOT EXISTS (SELECT 1 FROM tiles child WHERE child.parent_id=t.id) ORDER BY id`).all(Number(id));
}
