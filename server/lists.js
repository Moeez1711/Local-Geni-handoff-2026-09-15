import crypto from 'node:crypto';
import { db } from './db.js';
import { queryLeads } from './repo.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const FILTERS = ['q', 'category', 'country', 'tier', 'leadStatus', 'contact', 'minRating', 'minScore'];
export function listFilters(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'Choose valid segment filters.');
  if (Object.keys(input).some(key => !FILTERS.includes(key))) throw fail(400, 'This segment contains an unsupported filter.');
  const result = {};
  for (const key of FILTERS) {
    const value = input[key];
    if (value === '' || value == null) continue;
    if (['minRating', 'minScore'].includes(key)) {
      const n = Number(value);
      if (!['string', 'number'].includes(typeof value) || !Number.isFinite(n) || n < 0 || n > (key === 'minRating' ? 5 : 100)) throw fail(400, 'Choose a valid minimum rating or score.');
      result[key] = n;
    } else {
      if (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw fail(400, 'A segment filter is invalid.');
      if (key === 'contact' && !['email', 'phone', 'whatsapp'].includes(value)) throw fail(400, 'Choose a valid contact method.');
      if (key === 'tier' && !['hot', 'potential', 'low'].includes(value)) throw fail(400, 'Choose a valid lead priority.');
      if (key === 'leadStatus' && !['not_contacted', 'contacted', 'interested', 'converted', 'not_interested'].includes(value)) throw fail(400, 'Choose a valid lead status.');
      result[key] = value.trim();
    }
  }
  return result;
}
function idsFor(input, max = 1000) {
  if (!Array.isArray(input) || input.length > max || input.some(id => typeof id !== 'string' || !id || id.length > 300 || /[,\x00-\x1f\x7f]/.test(id))) throw fail(400, `Choose up to ${max} businesses.`);
  return [...new Set(input)].sort();
}

export function createListService({ database = db, query = queryLeads, now = Date.now } = {}) {
  database.exec(`CREATE TABLE IF NOT EXISTS crm_lists (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
    filters_json TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1,
    archived_at INTEGER, request_key TEXT NOT NULL UNIQUE, creation_digest TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS crm_list_members (
    list_id TEXT NOT NULL REFERENCES crm_lists(id), place_id TEXT NOT NULL REFERENCES businesses(place_id),
    PRIMARY KEY(list_id, place_id)
  );`);
  function atomic(fn) {
    database.exec('SAVEPOINT list_change');
    try { const value = fn(); database.exec('RELEASE list_change'); return value; }
    catch (error) { database.exec('ROLLBACK TO list_change; RELEASE list_change'); throw error; }
  }
  function get(id) {
    const row = database.prepare('SELECT * FROM crm_lists WHERE id=?').get(String(id));
    if (!row) throw fail(404, 'List not found.');
    return { id: row.id, name: row.name, kind: row.kind, filters: JSON.parse(row.filters_json), version: row.version,
      archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at,
      memberIds: row.kind === 'static' ? database.prepare('SELECT place_id FROM crm_list_members WHERE list_id=? ORDER BY place_id').all(row.id).map(item => item.place_id) : [] };
  }
  function matching(list, options = {}) {
    if (list.kind === 'static' && !list.memberIds.length) return { rows: [], total: 0 };
    const limit = Number(options.limit ?? 100), offset = Number(options.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) throw fail(400, 'Invalid list page.');
    let ids = list.kind === 'static' ? list.memberIds : null;
    if (options.ids) ids = ids ? options.ids.filter(id => ids.includes(id)) : options.ids;
    if (ids && !ids.length) return { rows: [], total: 0 };
    return query({ ...list.filters, ...(ids ? { ids: ids.join(',') } : {}), limit, offset, sort: 'score', dir: 'desc', trash: false });
  }
  function members(id, options = {}) {
    const list = get(id);
    if (list.archivedAt) return { list, rows: [], total: 0 };
    return { list, ...matching(list, options) };
  }
  function list(archived = false) {
    return { rows: database.prepare(`SELECT id FROM crm_lists WHERE archived_at IS ${archived ? 'NOT ' : ''}NULL ORDER BY updated_at DESC,id`).all().map(row => {
      const record = get(row.id);
      const count = matching(record, { limit: 1 }).total;
      const { memberIds, ...summary } = record;
      return { ...summary, count };
    }) };
  }
  function save(body, id) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'List details are required.');
    const previous = id ? get(id) : null;
    if (previous?.archivedAt) throw fail(409, 'Restore this list before editing it.');
    if (previous && body.version !== previous.version) throw fail(409, 'This list changed. Reload it before saving.');
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) throw fail(400, 'Enter a list name of up to 120 characters.');
    const kind = body.kind;
    if (!['static', 'segment'].includes(kind) || (previous && previous.kind !== kind)) throw fail(400, 'Choose a list type. Saved list types cannot be changed.');
    const filters = kind === 'segment' ? listFilters(body.filters) : {};
    const memberIds = kind === 'static' ? idsFor(body.memberIds || []) : [];
    const payload = { name, kind, filters, memberIds };
    const key = previous ? null : body.requestKey;
    if (!previous && (typeof key !== 'string' || !key || key.length > 100)) throw fail(400, 'A creation request is required.');
    if (key) {
      const existing = database.prepare('SELECT id,creation_digest FROM crm_lists WHERE request_key=?').get(key);
      if (existing) { if (existing.creation_digest !== digest(payload)) throw fail(409, 'This save request has different details. Start a new list.'); return get(existing.id); }
    }
    const active = database.prepare('SELECT 1 FROM businesses WHERE place_id=? AND deleted_at IS NULL');
    for (const placeId of memberIds) {
      // Retain existing membership while a business is in Trash; reject new deleted members.
      if (!active.get(placeId) && !previous?.memberIds.includes(placeId)) throw fail(409, 'A selected business is unavailable or in Trash. Refresh the selection.');
    }
    return atomic(() => {
      const nextId = previous?.id || crypto.randomUUID();
      if (previous) database.prepare('UPDATE crm_lists SET name=?,filters_json=?,version=version+1,updated_at=? WHERE id=?').run(name, JSON.stringify(filters), now(), nextId);
      else database.prepare('INSERT INTO crm_lists(id,name,kind,filters_json,request_key,creation_digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(nextId, name, kind, JSON.stringify(filters), key, digest(payload), now(), now());
      database.prepare('DELETE FROM crm_list_members WHERE list_id=?').run(nextId);
      const insert = database.prepare('INSERT INTO crm_list_members(list_id,place_id) VALUES(?,?)');
      for (const placeId of memberIds) insert.run(nextId, placeId);
      return get(nextId);
    });
  }
  function archive(id, body, restore = false) {
    const current = get(id);
    if (body?.version !== current.version) throw fail(409, 'This list changed. Reload it before continuing.');
    database.prepare('UPDATE crm_lists SET archived_at=?,version=version+1,updated_at=? WHERE id=?').run(restore ? null : now(), now(), id);
    return get(id);
  }
  function recipients(id, body = {}) {
    const current = get(id);
    if (current.archivedAt) throw fail(409, 'Restore the list before preparing outreach.');
    if (!['email', 'whatsapp'].includes(body.channel)) throw fail(400, 'Choose email or WhatsApp.');
    const ids = idsFor(body.ids, 25);
    if (!ids.length) throw fail(400, 'Select at least one business.');
    const fresh = matching(current, { ids, limit: 25 }).rows;
    if (fresh.length !== ids.length) throw fail(409, 'A selected business left this list or moved to Trash. Refresh and review your selection.');
    const seen = new Set(), rows = [], excluded = [];
    for (const lead of fresh) {
      const email = (lead.emails || []).find(value => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
      const to = body.channel === 'email' ? email : lead.whatsapp || lead.phone_e164;
      let reason = lead.lead_status === 'not_interested' ? 'Not interested' : !to ? `No ${body.channel === 'email' ? 'email address' : 'phone number'}` : '';
      const key = String(to || '').toLowerCase();
      if (!reason && seen.has(key)) reason = 'Duplicate recipient';
      if (reason) excluded.push({ placeId: lead.place_id, name: lead.name, reason });
      else { seen.add(key); rows.push({ placeId: lead.place_id, name: lead.name, to, emails: lead.emails || [] }); }
    }
    return { name: current.name, rows, excluded };
  }
  return { list, get, save, archive, members, recipients, preview: filters => matching({ kind: 'segment', filters: listFilters(filters) }) };
}
export const listService = createListService();
