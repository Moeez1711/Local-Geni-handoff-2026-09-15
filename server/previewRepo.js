/** Private external design links, pipeline progress, and outreach history.
 * Legacy image and publication tables are retained without active hosting APIs. */
import { isIP } from 'node:net';
import { db, json, tx } from './db.js';
import { getLead } from './repo.js';

export const STAGES = ['shortlisted', 'designing', 'ready', 'shared', 'replied', 'call_booked', 'won', 'lost'];
export const httpError = (status, message) => Object.assign(new Error(message), { status });

db.exec(`
CREATE TABLE IF NOT EXISTS lead_previews (
  place_id TEXT PRIMARY KEY REFERENCES businesses(place_id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'shortlisted',
  draft_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  share_token TEXT UNIQUE,
  published_at INTEGER,
  snapshot_json TEXT
);
CREATE TABLE IF NOT EXISTS preview_assets (
  id TEXT PRIMARY KEY,
  place_id TEXT NOT NULL REFERENCES businesses(place_id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_preview_assets_lead ON preview_assets(place_id);
CREATE TABLE IF NOT EXISTS preview_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id TEXT NOT NULL REFERENCES businesses(place_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  channel TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(place_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_preview_activity_lead ON preview_activity(place_id, created_at);
`);

function assertLead(placeId) {
  const lead = getLead(placeId);
  if (!lead) throw httpError(404, 'Business not found');
  return lead;
}
const readRow = (id) => db.prepare('SELECT * FROM lead_previews WHERE place_id=?').get(id);

function draftFor(row, lead) {
  return {
    title: `Website project for ${lead.name}`,
    contactName: '', brief: '', improvements: [], publicUrl: '', designUrl: '', minutesSpent: 0, dealValue: 0,
    ...json(row?.draft_json, {}),
  };
}

function previewFor(row, lead) {
  const draft = draftFor(row, lead);
  // Explicit projection keeps retired local hosting tokens and image paths private.
  return {
    title: draft.title, contactName: draft.contactName, brief: draft.brief, improvements: draft.improvements,
    publicUrl: draft.publicUrl, designUrl: draft.designUrl, minutesSpent: draft.minutesSpent, dealValue: draft.dealValue,
    place_id: lead.place_id, stage: row?.stage || 'shortlisted', exists: !!row,
    updatedAt: row?.updated_at || null,
  };
}

export function getPreview(placeId) {
  const lead = assertLead(placeId);
  return {
    lead, preview: previewFor(readRow(placeId), lead),
    activity: db.prepare(`SELECT id,kind,channel,message,created_at AS createdAt FROM preview_activity
      WHERE place_id=? ORDER BY created_at DESC,id DESC LIMIT 200`).all(placeId),
  };
}

export function listPreviews(filters = {}) {
  const conditions = ['b.deleted_at IS NULL'];
  const params = [];
  if (filters.stage) {
    if (!STAGES.includes(filters.stage)) throw httpError(400, 'Invalid pipeline stage');
    conditions.push('p.stage=?'); params.push(filters.stage);
  }
  if (filters.q) {
    conditions.push('(b.name LIKE ? OR b.category LIKE ? OR b.website LIKE ?)');
    params.push(...Array(3).fill(`%${String(filters.q).trim().slice(0, 200)}%`));
  }
  const rows = db.prepare(`SELECT p.*,b.name,b.category,b.website,b.country_code,b.score,b.tier,b.rating,b.review_count
    FROM lead_previews p JOIN businesses b ON p.place_id=b.place_id
    ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY p.updated_at DESC`).all(...params).map((r) => ({
      name: r.name, category: r.category, website: r.website, country_code: r.country_code,
      score: r.score, tier: r.tier, rating: r.rating, review_count: r.review_count,
      ...previewFor(r, r),
    }));
  const summary = { total: 0, ready: 0, shared: 0, replied: 0, repliedToSent: 0, callsBooked: 0, won: 0, minutesSpent: 0, revenue: 0 };
  const stageCounts = Object.fromEntries(STAGES.map((stage) => [stage, 0]));
  const categories = new Map();
  for (const row of db.prepare(`SELECT p.stage,p.draft_json,b.category,
    EXISTS(SELECT 1 FROM preview_activity a WHERE a.place_id=p.place_id AND a.kind='sent') AS was_sent,
    EXISTS(SELECT 1 FROM preview_activity a WHERE a.place_id=p.place_id AND a.kind='reply') AS was_replied,
    EXISTS(SELECT 1 FROM preview_activity a WHERE a.place_id=p.place_id AND a.kind='call_booked') AS was_booked
    FROM lead_previews p JOIN businesses b ON b.place_id=p.place_id WHERE b.deleted_at IS NULL`).all()) {
    const draft = json(row.draft_json, {});
    summary.total++;
    stageCounts[row.stage]++;
    if (row.stage === 'ready') summary.ready++;
    if (row.stage === 'won') summary.won++;
    if (row.was_sent) summary.shared++;
    if (row.was_replied) summary.replied++;
    if (row.was_sent && row.was_replied) summary.repliedToSent++;
    if (row.was_booked) summary.callsBooked++;
    summary.minutesSpent += draft.minutesSpent || 0;
    if (row.stage === 'won') summary.revenue += draft.dealValue || 0;
    const category = row.category || 'Uncategorized';
    if (!categories.has(category)) categories.set(category, { category, total: 0, sent: 0, replied: 0, won: 0, minutesSpent: 0, revenue: 0 });
    const group = categories.get(category);
    group.total++;
    if (row.was_sent) group.sent++;
    if (row.was_replied) group.replied++;
    if (row.stage === 'won') { group.won++; group.revenue += draft.dealValue || 0; }
    group.minutesSpent += draft.minutesSpent || 0;
  }
  summary.revenue = Math.round(summary.revenue * 100) / 100;
  const byCategory = [...categories.values()].map((g) => ({ ...g, revenue: Math.round(g.revenue * 100) / 100 })).sort((a, b) => b.won - a.won || b.replied - a.replied || b.total - a.total);
  return { rows, summary, stageCounts, byCategory };
}

function cleanText(value, field, max) {
  if (typeof value !== 'string') throw httpError(400, `${field} must be text`);
  if (value.length > max) throw httpError(400, `${field} must be ${max} characters or fewer`);
  return value.trim();
}

export function validateUrl(value, field, allowContact = false) {
  const str = cleanText(value, field, 2048);
  if (!str) return '';
  if (/[\u0000-\u0020\u007f]/.test(str) || /%(?:0a|0d)/i.test(str)) throw httpError(400, `${field} contains invalid characters`);
  let url;
  try { url = new URL(str); } catch { throw httpError(400, `${field} must be a complete URL`); }
  if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) {
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!allowContact && (url.port || isIP(host.replace(/^\[|\]$/g, '')) || !/\.[a-z]{2,}$/.test(host) || /(?:^|\.)(?:localhost|local|internal|lan|test|invalid|example)$/.test(host) || /(?:^|\.)(?:example\.(?:com|org|net)|localtest\.me|lvh\.me)$/.test(host))) throw httpError(400, `${field} must be a public external HTTPS link`);
    return url.href;
  }
  if (allowContact && url.protocol === 'mailto:' && /^[^?\s@]+@[^?\s@]+\.[^?\s@]+(?:\?[^\s]*)?$/.test(str.slice(7))) return str;
  if (allowContact && url.protocol === 'tel:' && /^\+?[0-9().-]{3,30}$/.test(str.slice(4))) return str;
  throw httpError(400, `${field} must use ${allowContact ? 'https, mailto, or tel' : 'https'}`);
}

export function externalPublicUrl(preview) {
  try { return validateUrl(preview?.publicUrl || '', 'Design link'); } catch { return ''; }
}
function assertDesign(draft) {
  const validLink = (value) => { try { return !!validateUrl(value || '', 'Design link'); } catch { return false; } };
  if (!validLink(draft.publicUrl) && !validLink(draft.designUrl)) throw httpError(400, 'Add an external HTTPS design link before marking this project ready');
}
function writeDraft(placeId, draft, stage, now = Date.now()) {
  db.prepare(`INSERT INTO lead_previews (place_id,stage,draft_json,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(place_id) DO UPDATE SET stage=excluded.stage,draft_json=excluded.draft_json,updated_at=excluded.updated_at`)
    .run(placeId, stage, JSON.stringify(draft), now);
}

export function savePreview(placeId, body = {}) {
  const lead = assertLead(placeId);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Provide a project object');
  const row = readRow(placeId);
  const draft = draftFor(row, lead);
  for (const [field, max] of Object.entries({ title: 200, contactName: 120, brief: 10000 })) {
    if (body[field] !== undefined) draft[field] = cleanText(body[field], field, max);
  }
  if (!draft.title) throw httpError(400, 'Add a project title');
  if (body.assets !== undefined || body.dataUrl !== undefined) throw httpError(400, 'Images are managed by your external designer. Save a design link here.');
  if (body.improvements !== undefined) {
    if (!Array.isArray(body.improvements) || body.improvements.length > 3) throw httpError(400, 'Add up to three improvements');
    draft.improvements = body.improvements.map((s) => cleanText(s, 'Improvement', 300)).filter(Boolean);
  }
  for (const field of ['publicUrl', 'designUrl']) {
    if (body[field] !== undefined) draft[field] = validateUrl(body[field], field);
  }
  for (const [field, max] of [['minutesSpent', 10000000], ['dealValue', 1000000000]]) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== 'number' || !Number.isFinite(body[field]) || body[field] < 0 || body[field] > max) throw httpError(400, `${field} must be a positive number or zero`);
      draft[field] = field === 'minutesSpent' ? Math.round(body[field]) : Math.round(body[field] * 100) / 100;
    }
  }
  const stage = body.stage ?? row?.stage ?? 'shortlisted';
  if (!STAGES.includes(stage)) throw httpError(400, 'Invalid pipeline stage');
  if (stage === 'ready') assertDesign(draft);
  writeDraft(placeId, draft, stage);
  return getPreview(placeId);
}

export function recordActivity(placeId, body = {}, { transaction = true, providerAccepted = false } = {}) {
  const lead = assertLead(placeId);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Provide an activity object');
  if (!['draft_opened', 'sent', 'reply', 'call_booked'].includes(body.kind)) throw httpError(400, 'Invalid activity type');
  if (!['whatsapp', 'email', 'phone', 'other'].includes(body.channel)) throw httpError(400, 'Invalid outreach channel');
  const message = body.message ?? '';
  if (typeof message !== 'string' || message.length > 10000) throw httpError(400, 'Message must be text of 10000 characters or fewer');
  const key = body.idempotencyKey == null ? null : cleanText(body.idempotencyKey, 'Idempotency key', 150);
  const write = () => {
    if (key) {
      const existing = db.prepare('SELECT kind,channel,message FROM preview_activity WHERE place_id=? AND idempotency_key=?').get(placeId, key);
      if (existing) {
        if (existing.kind !== body.kind || existing.channel !== body.channel || existing.message !== message) throw httpError(409, 'This activity key has already been used');
        return;
      }
    }
    const now = Date.now(); const row = readRow(placeId);
    if (!providerAccepted && body.channel === 'whatsapp' && ['draft_opened', 'sent'].includes(body.kind)) {
      const number = [lead.whatsapp, lead.phone_e164].map((value) => String(value || '').trim().replace(/^\+/, '').replace(/[ ()-]/g, '')).find((value) => /^[1-9]\d{6,14}$/.test(value));
      const hasSuppressions = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='whatsapp_suppressions'").get();
      const suppressed = number && hasSuppressions && db.prepare('SELECT 1 FROM whatsapp_suppressions WHERE number=?').get(number);
      if (lead.lead_status === 'not_interested' || row?.stage === 'lost' || suppressed) throw httpError(409, 'This business is not accepting WhatsApp outreach.');
    }
    let stage = row?.stage || 'shortlisted';
    const target = { sent: 'shared', reply: 'replied', call_booked: 'call_booked' }[body.kind];
    if (target && !['won', 'lost'].includes(stage) && STAGES.indexOf(target) > STAGES.indexOf(stage)) stage = target;
    db.prepare('INSERT INTO preview_activity (place_id,kind,channel,message,idempotency_key,created_at) VALUES (?,?,?,?,?,?)')
      .run(placeId, body.kind, body.channel, message, key || null, now);
    if (body.kind === 'sent') db.prepare(`UPDATE businesses SET last_contacted_at=?,
      lead_status=CASE WHEN lead_status='not_contacted' THEN 'contacted' ELSE lead_status END WHERE place_id=?`).run(now, placeId);
    writeDraft(placeId, draftFor(row, lead), stage, now);
  };
  if (transaction) tx(write); else write();
  return getPreview(placeId);
}
