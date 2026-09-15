/** Data access for businesses/leads, scans stats and analytics. All SQL lives here or in db.js. */
import { db, json, tx } from './db.js';
import { config } from './config.js';
import { scoreLead } from './scoring.js';
import { classifyPhone, isMobileType } from './enrich/contacts.js';
import { domainOf, nameKey } from './util.js';

const v = (x) => (x === undefined ? null : typeof x === 'boolean' ? Number(x) : x);
const JSON_COLS = { types: [], hours: null, emails: [], socials: {}, site: null, reasons: [] };

export function hydrate(row) {
  if (!row) return null;
  const out = { ...row };
  for (const [k, d] of Object.entries(JSON_COLS)) out[k] = json(row[k], d);
  // Older scans retain the original scoring copy. Present those labels in the
  // current plain style without rewriting business records or score values.
  out.reasons = out.reasons.map((reason) => ({ ...reason, label: String(reason.label || '').replaceAll('★', ' out of 5').replaceAll(' — ', '; ') }));
  out.open_now = row.open_now == null ? null : Boolean(row.open_now);
  return out;
}

const q = {
  byId: db.prepare('SELECT * FROM businesses WHERE place_id = ?'),
  byPhone: db.prepare('SELECT * FROM businesses WHERE phone_e164 = ? AND name_key = ? LIMIT 1'),
  byDomain: db.prepare('SELECT * FROM businesses WHERE website_domain = ? AND name_key = ? LIMIT 1'),
  insert: db.prepare(`INSERT INTO businesses (place_id,name,name_key,address,lat,lng,country_code,phone_national,phone_intl,
    phone_e164,phone_type,website,website_domain,rating,review_count,category,category_value,types,business_status,open_now,
    hours,maps_url,whatsapp,whatsapp_source,site_status,first_seen,last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  refresh: db.prepare(`UPDATE businesses SET name=?,name_key=?,address=?,lat=?,lng=?,phone_national=?,phone_intl=?,phone_e164=?,
    phone_type=?,website=?,website_domain=?,rating=?,review_count=?,category=?,category_value=COALESCE(category_value,?),types=?,
    business_status=?,open_now=?,hours=?,maps_url=?,site_status=?,whatsapp=?,whatsapp_source=?,last_seen=? WHERE place_id=?`),
  link: db.prepare('INSERT OR IGNORE INTO scan_businesses (scan_id, place_id, found_at, is_new) VALUES (?,?,?,?)'),
  saveScore: db.prepare('UPDATE businesses SET score=?, tier=?, reasons=? WHERE place_id=?'),
  claim: db.prepare(`SELECT place_id, website, website_domain FROM businesses WHERE deleted_at IS NULL AND site_status='pending' AND website IS NOT NULL ORDER BY score DESC LIMIT ?`),
  markAnalyzing: db.prepare(`UPDATE businesses SET site_status='analyzing' WHERE place_id=?`),
  siteByDomain: db.prepare(`SELECT site FROM businesses WHERE website_domain=? AND analyzed_at > ? AND site_status IN ('ok','broken') LIMIT 1`),
  saveSite: db.prepare(`UPDATE businesses SET site_status=?, site=?, emails=?, socials=?, whatsapp=?, whatsapp_source=?, analyzed_at=? WHERE place_id=?`),
};

export const getLead = (placeId, { includeDeleted = false } = {}) => { const lead = hydrate(q.byId.get(placeId)); return lead?.deleted_at != null && !includeDeleted ? null : lead; };

export function trashLeads(ids, restore = false) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !id || id.length > 300)) throw httpErr(400, 'Select between 1 and 1,000 leads.');
  const unique = [...new Set(ids)], marks = unique.map(() => '?').join(',');
  return tx(() => {
    const hasTable = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    if (!restore && hasTable('email_messages') && db.prepare(`SELECT 1 FROM email_messages WHERE place_id IN (${marks}) AND status='sending' LIMIT 1`).get(...unique)) throw httpErr(409, 'An email is being sent to a selected business. Try deleting it after sending finishes.');
    if (!restore && hasTable('whatsapp_outbox') && db.prepare(`SELECT 1 FROM whatsapp_outbox WHERE place_id IN (${marks}) AND status='sending' LIMIT 1`).get(...unique)) throw httpErr(409, 'A WhatsApp message is being submitted for a selected business. Wait for its outcome before deleting.');
    const result = db.prepare(`UPDATE businesses SET deleted_at=?,site_status=CASE WHEN site_status='analyzing' THEN 'pending' ELSE site_status END WHERE place_id IN (${marks}) AND deleted_at IS ${restore ? 'NOT ' : ''}NULL`).run(restore ? null : Date.now(), ...unique);
    if (!restore && hasTable('email_campaign_recipients')) db.prepare(`UPDATE email_campaign_recipients SET status='stopped',stop_reason='Business moved to Trash' WHERE place_id IN (${marks}) AND status='pending'`).run(...unique);
    if (!restore && hasTable('whatsapp_outbox')) db.prepare(`UPDATE whatsapp_outbox SET status='cancelled',updated_at=?,error_code='WHATSAPP_LEAD_DELETED',error_message='Business moved to Trash.' WHERE place_id IN (${marks}) AND status='queued'`).run(Date.now(), ...unique);
    return { count: Number(result.changes), ids: unique, restored: restore };
  });
}

export function rescore(placeId) {
  const b = getLead(placeId);
  if (!b) return null;
  const { score, tier, reasons } = scoreLead(b);
  q.saveScore.run(score, tier, JSON.stringify(reasons), placeId);
  return { ...b, score, tier, reasons };
}

/**
 * Inserts or refreshes a place. Dedupe order: Place ID, then E.164 phone + normalised name,
 * then website domain + normalised name (catches re-issued Place IDs for the same business).
 */
export function existingPlace(p, countryCode) {
  const phone = classifyPhone(p.phoneIntl, p.phoneNational, countryCode);
  const domain = p.website ? domainOf(p.website) : null, key = nameKey(p.name);
  return q.byId.get(p.sourceId) || (phone.e164 && key && q.byPhone.get(phone.e164, key)) || (domain && key && q.byDomain.get(domain, key));
}

export function upsertPlace(p, { scanId, countryCode, categoryValue }) {
  const now = Date.now();
  const phone = classifyPhone(p.phoneIntl, p.phoneNational, countryCode);
  const domain = p.website ? domainOf(p.website) : null;
  const key = nameKey(p.name);
  const existing = existingPlace(p, countryCode);
  if (existing?.deleted_at != null) return { placeId: existing.place_id, isNew: false, linked: false, ignored: true };
  const mobileWa = phone.e164 && isMobileType(phone.type) ? phone.e164 : null;

  let placeId;
  let isNew = false;
  if (existing) {
    placeId = existing.place_id;
    const siteChanged = (existing.website_domain || null) !== domain;
    const siteStatus = siteChanged ? (p.website ? 'pending' : 'none') : existing.site_status;
    const keepWa = existing.whatsapp_source === 'website' && !siteChanged;
    q.refresh.run(p.name, key, v(p.address), v(p.lat), v(p.lng), v(p.phoneNational), v(p.phoneIntl), v(phone.e164), v(phone.type),
      v(p.website), domain, v(p.rating), v(p.reviewCount), v(p.category), v(categoryValue), JSON.stringify(p.types || []),
      v(p.businessStatus), v(p.openNow), JSON.stringify(p.hours), v(p.mapsUrl), siteStatus,
      keepWa ? existing.whatsapp : mobileWa, keepWa ? 'website' : mobileWa ? 'mobile_unverified' : null, now, placeId);
  } else {
    isNew = true;
    placeId = p.sourceId;
    q.insert.run(placeId, p.name, key, v(p.address), v(p.lat), v(p.lng), v(countryCode), v(p.phoneNational), v(p.phoneIntl),
      v(phone.e164), v(phone.type), v(p.website), domain, v(p.rating), v(p.reviewCount), v(p.category), v(categoryValue),
      JSON.stringify(p.types || []), v(p.businessStatus), v(p.openNow), JSON.stringify(p.hours), v(p.mapsUrl),
      mobileWa, mobileWa ? 'mobile_unverified' : null, p.website ? 'pending' : 'none', now, now);
  }
  const linked = q.link.run(scanId, placeId, now, isNew ? 1 : 0).changes > 0;
  rescore(placeId);
  return { placeId, isNew, linked };
}

export function claimPendingSites(n) {
  return tx(() => {
    const rows = q.claim.all(n);
    for (const r of rows) q.markAnalyzing.run(r.place_id);
    return rows;
  });
}

/** Reuse a recent analysis of the same domain (chains/branches) instead of fetching again. */
export function cachedSiteFor(domain, maxAgeMs = 7 * 86400_000) {
  const row = domain && q.siteByDomain.get(domain, Date.now() - maxAgeMs);
  return row ? json(row.site) : null;
}

export function applySite(placeId, site) {
  const b = getLead(placeId);
  if (!b) return null;
  const emails = [...new Set([...(b.emails || []), ...(site.emails || [])])].slice(0, 5);
  const socials = { ...(site.socials || {}), ...(b.socials || {}) };
  if (site.status === 'social_only' && site.finalUrl) socials.listed = site.finalUrl;
  const [wa, waSource] = site.whatsapp ? [site.whatsapp, 'website'] : [b.whatsapp, b.whatsapp_source];
  q.saveSite.run(site.status, JSON.stringify(site), JSON.stringify(emails), JSON.stringify(socials), v(wa), v(waSource), Date.now(), placeId);
  return rescore(placeId);
}

export function requeueSite(placeId) {
  if (!getLead(placeId)) throw httpErr(404, 'Lead not found');
  db.prepare(`UPDATE businesses SET site_status = CASE WHEN website IS NULL THEN 'none' ELSE 'pending' END WHERE place_id=?`).run(placeId);
  return rescore(placeId);
}

const LEAD_STATUS_VALUES = ['not_contacted', 'contacted', 'interested', 'converted', 'not_interested'];
const httpErr = (status, message) => Object.assign(new Error(message), { status });

/** Partial update: lead_status, notes, follow_up_at (ms or null), contacted:true (stamps last contact). */
export function updateLead(placeId, body = {}) {
  const lead = getLead(placeId);
  if (!lead) throw httpErr(404, 'Lead not found');
  const sets = [];
  const params = [];
  let status = body.lead_status;
  if (body.contacted) {
    sets.push('last_contacted_at=?');
    params.push(Date.now());
    if (status === undefined && lead.lead_status === 'not_contacted') status = 'contacted';
  }
  if (status !== undefined) {
    if (!LEAD_STATUS_VALUES.includes(status)) throw httpErr(400, 'Invalid lead status');
    sets.push('lead_status=?');
    params.push(status);
  }
  if (body.notes !== undefined) { sets.push('notes=?'); params.push(String(body.notes).slice(0, 5000)); }
  if (body.follow_up_at !== undefined) {
    const ts = body.follow_up_at === null ? null : Number(body.follow_up_at);
    if (ts !== null && !Number.isFinite(ts)) throw httpErr(400, 'Invalid follow-up date');
    sets.push('follow_up_at=?');
    params.push(ts);
  }
  if (sets.length) db.prepare(`UPDATE businesses SET ${sets.join(', ')} WHERE place_id=?`).run(...params, placeId);
  return getLead(placeId);
}

const WEB_FILTERS = {
  none: `b.site_status='none'`,
  social_only: `b.site_status='social_only'`,
  broken: `b.site_status='broken'`,
  outdated: `(b.site_status='ok' AND json_extract(b.site,'$.design.verdict') IN ('outdated','dated'))`,
  not_mobile: `(b.site_status='ok' AND json_extract(b.site,'$.mobile.verdict')='unlikely')`,
  no_https: `(b.site_status='ok' AND json_extract(b.site,'$.https')=0)`,
  modern: `(b.site_status='ok' AND json_extract(b.site,'$.design.verdict')='modern')`,
  pending: `b.site_status IN ('pending','analyzing','unknown')`,
};
const SORTS = { score: 'b.score', rating: 'b.rating', reviews: 'b.review_count', name: 'b.name', recent: 'b.first_seen', followup: 'b.follow_up_at' };
const OPEN_PIPELINE = `b.lead_status NOT IN ('converted','not_interested')`;
const endOfToday = () => new Date().setHours(23, 59, 59, 999);

function buildWhere(f) {
  const where = [f.trash === true || f.trash === 'true' || f.trash === '1' ? 'b.deleted_at IS NOT NULL' : 'b.deleted_at IS NULL'];
  const params = [];
  let from = 'businesses b';
  if (f.scanId) { from += ' JOIN scan_businesses sb ON sb.place_id=b.place_id AND sb.scan_id=?'; params.push(Number(f.scanId)); }
  if (f.q) {
    where.push('(b.name LIKE ? OR b.address LIKE ? OR b.category LIKE ? OR b.phone_e164 LIKE ? OR b.notes LIKE ? OR b.website LIKE ?)');
    params.push(...Array(6).fill(`%${String(f.q).trim()}%`));
  }
  const list = (val) => String(val || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const [key, col] of [['tier', 'b.tier'], ['leadStatus', 'b.lead_status'], ['category', 'b.category'], ['country', 'b.country_code']]) {
    const vals = list(f[key]);
    if (vals.length) { where.push(`${col} IN (${vals.map(() => '?').join(',')})`); params.push(...vals); }
  }
  const web = list(f.web).filter((k) => WEB_FILTERS[k]);
  if (web.length) where.push(`(${web.map((k) => WEB_FILTERS[k]).join(' OR ')})`);
  if (f.minRating) { where.push('b.rating >= ?'); params.push(Number(f.minRating)); }
  if (f.minReviews) { where.push('b.review_count >= ?'); params.push(Number(f.minReviews)); }
  if (f.minScore) { where.push('b.score >= ?'); params.push(Number(f.minScore)); }
  if (f.contact === 'whatsapp') where.push('b.whatsapp IS NOT NULL');
  if (f.contact === 'phone') where.push('b.phone_e164 IS NOT NULL');
  if (f.contact === 'email') where.push(`b.emails != '[]'`);
  if (f.followUp === 'due') { where.push(`b.follow_up_at IS NOT NULL AND b.follow_up_at <= ? AND ${OPEN_PIPELINE}`); params.push(endOfToday()); }
  if (f.followUp === 'scheduled') where.push(`b.follow_up_at IS NOT NULL AND ${OPEN_PIPELINE}`);
  if (f.searchCategory) {
    where.push(`EXISTS (SELECT 1 FROM scan_businesses sbc JOIN scans sc ON sc.id = sbc.scan_id
      WHERE sbc.place_id = b.place_id AND lower(json_extract(sc.config, '$.categoryLabel')) = lower(?))`);
    params.push(String(f.searchCategory));
  }
  if (f.ids) { const ids = list(f.ids); where.push(`b.place_id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
  if (!f.includeClosed) where.push(`COALESCE(b.business_status,'') != 'CLOSED_PERMANENTLY'`);
  return { from, where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function queryLeads(f = {}) {
  const { from, where, params } = buildWhere(f);
  const sort = SORTS[f.sort] || 'b.score';
  const dir = f.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Number(f.limit) || 100, 5000);
  const offset = Math.max(Number(f.offset) || 0, 0);
  const total = db.prepare(`SELECT COUNT(*) n FROM ${from} ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT b.* FROM ${from} ${where} ORDER BY ${sort} ${dir} NULLS LAST, b.review_count DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset).map(hydrate);
  return { total, rows };
}

export function mapPoints(f = {}) {
  const { from, where, params } = buildWhere(f);
  return db.prepare(`SELECT b.place_id, b.name, b.lat, b.lng, b.tier, b.score FROM ${from} ${where} ORDER BY b.score DESC LIMIT 3000`).all(...params);
}

export function categoriesInUse(f = {}) {
  const { from, where, params } = buildWhere({ scanId: f.scanId, country: f.country, searchCategory: f.searchCategory, trash: f.trash });
  return db.prepare(`SELECT b.category k, COUNT(*) n FROM ${from} ${where} AND b.category IS NOT NULL GROUP BY k ORDER BY n DESC`).all(...params);
}

/** Lead counts per country for the current filters (ignoring the country filter itself) — drives the country tabs. */
export function countriesInUse(f = {}) {
  const { from, where, params } = buildWhere({ ...f, country: '' });
  return db.prepare(`SELECT b.country_code k, COUNT(*) n FROM ${from} ${where} AND b.country_code IS NOT NULL GROUP BY k ORDER BY n DESC`).all(...params);
}

const n0 = (o) => Object.fromEntries(Object.entries(o).map(([k, val]) => [k, val ?? 0]));

export function scanStats(scanId) {
  const t = db.prepare(`SELECT COUNT(*) total, SUM(status='done') done, SUM(status='failed') failed, SUM(status='active') active,
    SUM(status='pending') pending, MAX(depth) depth FROM tiles WHERE scan_id=?`).get(scanId);
  const l = db.prepare(`SELECT COUNT(*) discovered, SUM(sb.is_new) fresh, SUM(b.tier='hot') hot, SUM(b.tier='potential') potential,
    SUM(b.site_status IN ('pending','analyzing')) sitesPending, SUM(b.site_status IN ('none','social_only','broken')) noSite,
    SUM(b.whatsapp IS NOT NULL) whatsapp FROM scan_businesses sb JOIN businesses b ON b.place_id=sb.place_id WHERE sb.scan_id=? AND b.deleted_at IS NULL`).get(scanId);
  // The ts guard ignores calls logged against the same id before this scan existed (e.g. after a manual data reset).
  const a = db.prepare(`SELECT SUM(outcome='ok') billed, SUM(outcome='cached') cached, SUM(outcome='error') errors
    FROM api_calls WHERE scan_id=? AND ts >= (SELECT created_at FROM scans WHERE id=?)`).get(scanId, scanId);
  const s = n0({ tilesTotal: t.total, tilesDone: t.done, tilesFailed: t.failed, tilesActive: t.active, tilesPending: t.pending,
    depth: t.depth, ...l, billedCalls: a.billed, cachedCalls: a.cached, apiErrors: a.errors });
  s.qualified = s.hot + s.potential;
  const leaf = db.prepare(`SELECT depth, COUNT(*) total, SUM(status='done') done, SUM(status='done' AND saturated=1) capped
    FROM tiles t WHERE scan_id=? AND NOT EXISTS (SELECT 1 FROM tiles child WHERE child.parent_id=t.id) GROUP BY depth`).all(scanId);
  const weight = (key) => leaf.reduce((sum, row) => sum + Number(row[key] || 0) / 4 ** row.depth, 0);
  s.coveragePercent = weight('total') ? Math.min(100, 100 * weight('done') / weight('total')) : 0;
  s.areasTotal = leaf.reduce((sum, row) => sum + row.total, 0);
  s.areasDone = leaf.reduce((sum, row) => sum + Number(row.done || 0), 0);
  s.cappedAreas = leaf.reduce((sum, row) => sum + Number(row.capped || 0), 0);
  s.candidates = db.prepare('SELECT COUNT(*) n FROM scan_candidates WHERE scan_id=?').get(scanId).n;
  s.excluded = db.prepare('SELECT COUNT(*) n FROM scan_candidates WHERE scan_id=? AND reason IS NOT NULL').get(scanId).n;
  return s;
}

export function analytics(scanId) {
  const join = scanId ? `JOIN scan_businesses sb ON sb.place_id=b.place_id AND sb.scan_id=${Number(scanId)}` : '';
  const open = `WHERE b.deleted_at IS NULL AND COALESCE(b.business_status,'') != 'CLOSED_PERMANENTLY'`;
  const grp = (expr) => db.prepare(`SELECT ${expr} k, COUNT(*) n FROM businesses b ${join} ${open} GROUP BY k ORDER BY n DESC`).all();
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const usage = (since) => n0(db.prepare(`SELECT SUM(outcome='ok') billed, SUM(outcome='cached') cached, SUM(outcome='error') errors
    FROM api_calls WHERE ts >= ?`).get(since));
  const month = usage(monthStart);
  return {
    totals: n0(db.prepare(`SELECT COUNT(*) total, SUM(b.tier='hot') hot, SUM(b.tier='potential') potential, SUM(b.whatsapp IS NOT NULL) whatsapp,
      SUM(b.phone_e164 IS NOT NULL) phone, SUM(b.emails != '[]') email, SUM(b.site_status IN ('none','social_only','broken')) noSite,
      AVG(b.score) avgScore FROM businesses b ${join} ${open}`).get()),
    tiers: grp('b.tier'),
    web: grp(`CASE WHEN b.site_status='ok' THEN 'site_' || COALESCE(json_extract(b.site,'$.design.verdict'),'unknown') ELSE b.site_status END`),
    leadStatus: grp('b.lead_status'),
    categories: grp('b.category').slice(0, 12),
    ratings: grp(`CASE WHEN b.rating IS NULL THEN 'No rating' WHEN b.rating>=4.5 THEN '4.5+' WHEN b.rating>=4 THEN '4.0–4.4' WHEN b.rating>=3.5 THEN '3.5–3.9' ELSE '<3.5' END`),
    api: {
      today: usage(dayStart),
      month,
      estMonthCostUsd: Math.round(month.billed * config.placesCostPer1000) / 1000,
      costPer1000: config.placesCostPer1000,
      daily: db.prepare(`SELECT date(ts/1000,'unixepoch','localtime') d, SUM(outcome='ok') billed, SUM(outcome='cached') cached,
        SUM(outcome='error') errors FROM api_calls WHERE ts >= ? GROUP BY d ORDER BY d`).all(Date.now() - 14 * 86400_000),
      recentErrors: db.prepare(`SELECT ts, scan_id, endpoint, http_code, error FROM api_calls WHERE outcome='error' ORDER BY ts DESC LIMIT 15`).all(),
    },
  };
}

export function followUpSummary() {
  const end = endOfToday();
  return n0(db.prepare(`SELECT SUM(b.follow_up_at <= ?) due, SUM(b.follow_up_at > ?) upcoming FROM businesses b
    WHERE b.deleted_at IS NULL AND b.follow_up_at IS NOT NULL AND ${OPEN_PIPELINE}`).get(end, end));
}

export const getSettings = () => json(db.prepare(`SELECT value FROM settings WHERE key='app'`).get()?.value, {});

export function saveSettings(patch = {}) {
  const next = { ...getSettings(), ...patch };
  const value = JSON.stringify(next);
  if (value.length > 50_000) throw httpErr(400, 'Settings too large');
  db.prepare(`INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(value);
  return next;
}

/** Lead counts per searched category (what you scanned for) — drives the category tabs. */
export function searchCategoriesInUse(f = {}) {
  const { from, where, params } = buildWhere({ ...f, searchCategory: '' });
  const onlyScan = f.scanId ? 'AND sc.id = ?' : '';
  const counts = new Map(db.prepare(`SELECT lower(json_extract(sc.config, '$.categoryLabel')) k, COUNT(DISTINCT b.place_id) n
    FROM ${from} JOIN scan_businesses sbc ON sbc.place_id = b.place_id JOIN scans sc ON sc.id = sbc.scan_id
    ${where} ${onlyScan} GROUP BY k`).all(...params, ...(f.scanId ? [Number(f.scanId)] : [])).map((r) => [r.k, r.n]));
  // Every category ever searched gets a tab, even when the current filters leave it with no leads.
  const rows = db.prepare(`SELECT json_extract(config, '$.categoryLabel') k FROM scans GROUP BY lower(k)`).all()
    .filter((r) => r.k)
    .map((r) => ({ k: r.k, n: counts.get(r.k.toLowerCase()) || 0 }))
    .sort((a, b) => b.n - a.n || a.k.localeCompare(b.k));
  const total = db.prepare(`SELECT COUNT(*) n FROM ${from} ${where}`).get(...params).n;
  return { total, rows };
}
