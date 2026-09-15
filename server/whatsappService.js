/** Optional Meta Cloud API. Explicitly reviewed templates only; no browser automation.
 * Provider acceptance is the only available status without a delivery webhook.
 * API: https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api
 * Policy: https://whatsappbusiness.com/policy/
 */
import crypto from 'node:crypto';
import { db, json, tx } from './db.js';
import { createEmailVault } from './emailVault.js';
import { createWhatsAppBusinessInbox } from './whatsappBusinessInbox.js';
import { getLead } from './repo.js';
import { getPreview, recordActivity, validateUrl } from './previewRepo.js';

db.exec(`
CREATE TABLE IF NOT EXISTS whatsapp_account (
 id INTEGER PRIMARY KEY CHECK(id=1), config_json TEXT NOT NULL, secret TEXT, revision TEXT NOT NULL,
 verified INTEGER NOT NULL DEFAULT 0, metadata_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS whatsapp_templates (
 id TEXT PRIMARY KEY, account_revision TEXT NOT NULL, template_json TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS whatsapp_consents (
 place_id TEXT NOT NULL REFERENCES businesses(place_id), number TEXT NOT NULL, business_account_id TEXT NOT NULL,
 opted_in INTEGER NOT NULL, evidence TEXT NOT NULL, revision TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(place_id,number,business_account_id)
);
CREATE TABLE IF NOT EXISTS whatsapp_consent_events (
 id TEXT PRIMARY KEY, place_id TEXT NOT NULL, number TEXT NOT NULL, business_account_id TEXT NOT NULL,
 opted_in INTEGER NOT NULL, evidence TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS whatsapp_suppressions (
 number TEXT PRIMARY KEY, reason TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS whatsapp_reviews (
 token_hash TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, digest TEXT NOT NULL, expires_at INTEGER NOT NULL,
 consumed_batch_id TEXT UNIQUE, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS whatsapp_batches (
 id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, review_hash TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL, next_attempt_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 hold_reason TEXT
);
CREATE TABLE IF NOT EXISTS whatsapp_outbox (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES whatsapp_batches(id), place_id TEXT NOT NULL REFERENCES businesses(place_id),
 number TEXT NOT NULL, status TEXT NOT NULL, snapshot_json TEXT NOT NULL, account_revision TEXT NOT NULL,
 provider_message_id TEXT, attempted_at INTEGER, accepted_at INTEGER, error_code TEXT, error_message TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_outbox_batch ON whatsapp_outbox(batch_id,status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_outbox_lead ON whatsapp_outbox(place_id,created_at);
CREATE INDEX IF NOT EXISTS idx_whatsapp_attempts ON whatsapp_outbox(attempted_at);
`);

const defaults = Object.freeze({ phoneNumberId: '', businessAccountId: '', apiVersion: 'v26.0', dailyLimit: 25, hourlyLimit: 5, minIntervalSeconds: 120, paused: false });
const fail = (status, code, message) => Object.assign(new Error(message), { status, code, whatsappSafe: true });
const hash = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const uid = () => crypto.randomUUID();
const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const safeText = (value, name, max, required = false) => {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || (required && !value.trim())) throw fail(400, 'WHATSAPP_INPUT_INVALID', `${name} is invalid.`);
  return value;
};
export function normalizeWhatsAppNumber(value) {
  const number = String(value || '').trim().replace(/^\+/, '').replace(/[ ()-]/g, '');
  if (!/^[1-9]\d{6,14}$/.test(number)) throw fail(400, 'WHATSAPP_NUMBER_INVALID', 'A valid international WhatsApp number is required.');
  return number;
}
function leadNumber(lead) {
  for (const candidate of [lead.whatsapp, lead.phone_e164]) { try { return normalizeWhatsAppNumber(candidate); } catch {} }
  throw fail(409, 'WHATSAPP_NUMBER_MISSING', 'This business has no valid international phone number.');
}
function placeholders(text) {
  const matches = [...String(text || '').matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1]);
  if (matches.some((n) => !/^[1-9]\d?$/.test(n))) throw new Error('Only positional text parameters are supported.');
  const ids = [...new Set(matches.map(Number))].sort((a, b) => a - b);
  if (ids.some((n, i) => n !== i + 1)) throw new Error('Template parameters must be consecutive.');
  if (String(text || '').replace(/\{\{[^{}]+\}\}/g, '').match(/\{\{|\}\}/)) throw new Error('Unrecognized template parameters.');
  return ids;
}

/** A conservative supported subset; unsupported content is never silently dropped. */
export function normalizeWhatsAppTemplate(raw) {
  const result = { id: String(raw.id || ''), name: String(raw.name || ''), language: String(raw.language || ''), category: String(raw.category || ''), status: String(raw.status || ''), supported: false, unsupportedReason: '', header: '', body: '', footer: '', buttons: [], parameters: [] };
  try {
    if (!/^\d{3,32}$/.test(result.id) || !/^[a-z0-9_]{1,512}$/.test(result.name) || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(result.language)) throw new Error('Template identity is invalid.');
    if (raw.status !== 'APPROVED') throw new Error('This template is not approved.');
    if (!['MARKETING', 'UTILITY'].includes(raw.category)) throw new Error('Only marketing and utility text templates are supported.');
    if (raw.parameter_format && raw.parameter_format !== 'POSITIONAL') throw new Error('Named template parameters are not supported yet.');
    if (!Array.isArray(raw.components) || raw.components.length > 4) throw new Error('This template format is not supported.');
    const seen = new Set();
    for (const part of raw.components) {
      if (seen.has(part.type)) throw new Error('Duplicate template components are not supported.');
      seen.add(part.type);
      if (['HEADER', 'BODY', 'FOOTER'].includes(part.type)) {
        if (part.type === 'HEADER' && part.format !== 'TEXT') throw new Error('Media headers are not supported. Use a text template.');
        const key = part.type.toLowerCase();
        result[key] = safeText(part.text, 'Template text', key === 'body' ? 4096 : 1024, key === 'body');
        const ids = placeholders(part.text);
        if (key === 'footer' && ids.length) throw new Error('Dynamic footer text is not supported.');
        if (key === 'header' && ids.length > 1) throw new Error('Only one header parameter is supported.');
        for (const id of ids) result.parameters.push({ key: `${key}.${id}`, label: `${key === 'header' ? 'Header' : 'Body'} ${id}` });
      } else if (part.type === 'BUTTONS') {
        if (!Array.isArray(part.buttons) || part.buttons.length > 10) throw new Error('Template buttons are invalid.');
        for (const [index, button] of part.buttons.entries()) {
          const item = { index, type: button.type, text: safeText(button.text, 'Button label', 100, true) };
          if (button.type === 'URL') {
            item.url = safeText(button.url, 'Button URL', 2048, true);
            const ids = placeholders(item.url);
            if (ids.length && (ids.length !== 1 || !item.url.endsWith('{{1}}') || (item.url.match(/\{\{1\}\}/g) || []).length !== 1)) throw new Error('Only a single URL suffix parameter is supported.');
            try { validateUrl(item.url.replace('{{1}}', 'preview'), 'Button URL'); } catch { throw new Error('Buttons must use a public HTTPS URL.'); }
            if (ids.length) result.parameters.push({ key: `button.${index}`, label: `${item.text}: URL suffix` });
          } else if (button.type === 'PHONE_NUMBER') item.phoneNumber = normalizeWhatsAppNumber(button.phone_number);
          else throw new Error('Quick replies, flows, authentication and other interactive buttons are not supported.');
          result.buttons.push(item);
        }
      } else throw new Error('Media, carousel and other rich template components are not supported.');
    }
    if (!result.body) throw new Error('A text body is required.');
    result.supported = true;
  } catch (e) { result.unsupportedReason = e.whatsappSafe ? e.message : String(e.message || 'Unsupported template.'); }
  result.fingerprint = hash({ id: result.id, name: result.name, language: result.language, category: result.category, status: result.status, header: result.header, body: result.body, footer: result.footer, buttons: result.buttons, parameters: result.parameters, supported: result.supported });
  return result;
}

export function renderWhatsAppTemplate(template, parameters = {}) {
  if (!template.supported) throw fail(400, 'WHATSAPP_TEMPLATE_UNSUPPORTED', template.unsupportedReason || 'This template is not supported.');
  if (!plainObject(parameters) || Object.keys(parameters).some((key) => !template.parameters.some((p) => p.key === key))) throw fail(400, 'WHATSAPP_PARAMETERS_INVALID', 'Template parameters do not match the approved template.');
  for (const { key } of template.parameters) {
    safeText(parameters[key], `Parameter ${key}`, 1024, true);
    if (/[\r\n\t]/.test(parameters[key]) || / {5}/.test(parameters[key]) || /\{\{|\}\}/.test(parameters[key])) throw fail(400, 'WHATSAPP_PARAMETERS_INVALID', 'Parameters must contain final single-line text, without unresolved placeholders.');
  }
  const components = [];
  const rendered = {};
  for (const part of ['header', 'body', 'footer']) {
    const ids = placeholders(template[part]);
    rendered[part] = template[part].replace(/\{\{(\d+)\}\}/g, (_, n) => parameters[`${part}.${n}`]);
    if (ids.length) components.push({ type: part, parameters: ids.map((n) => ({ type: 'text', text: parameters[`${part}.${n}`] })) });
  }
  rendered.buttons = template.buttons.map((button) => {
    const value = { ...button };
    if (button.url?.includes('{{1}}')) {
      value.url = button.url.replace('{{1}}', () => parameters[`button.${button.index}`]);
      try { validateUrl(value.url, 'Button URL'); } catch { throw fail(400, 'WHATSAPP_PARAMETERS_INVALID', 'The final button link must be a public HTTPS URL.'); }
      components.push({ type: 'button', sub_type: 'url', index: String(button.index), parameters: [{ type: 'text', text: parameters[`button.${button.index}`] }] });
    }
    return value;
  });
  rendered.text = [rendered.header, rendered.body, rendered.footer, ...rendered.buttons.map((b) => `${b.text}: ${b.url || `+${b.phoneNumber}`}`)].filter(Boolean).join('\n\n');
  if (rendered.body.length > 4096 || rendered.text.length > 10000) throw fail(400, 'WHATSAPP_PARAMETERS_INVALID', 'The completed template is too long.');
  return { ...rendered, components };
}

export function createWhatsAppService({ fetchFn = globalThis.fetch, now = () => Date.now(), keyProvider, recordActivityFn = recordActivity, autoStart = false } = {}) {
  const vault = createEmailVault({ keyProvider });
  let timer = null, ticking = null, recovered = false;
  const account = () => db.prepare('SELECT * FROM whatsapp_account WHERE id=1').get();
  const configuration = (row = account()) => ({ ...defaults, ...json(row?.config_json, {}) });
  const assertRevision = (revision) => { const row = account(); if (!row || row.revision !== revision) throw fail(409, 'WHATSAPP_ACCOUNT_CHANGED', 'The WhatsApp account changed. Verify it and review a new batch.'); return row; };
  function getSettings() {
    const row = account(); return { ...configuration(row), ...json(row?.metadata_json, {}), configured: !!row?.secret, verified: !!row?.verified, hasToken: !!row?.secret, updatedAt: row?.updated_at || null, tracking: 'acceptance_only' };
  }
  function saveSettings(body = {}) {
    if (!plainObject(body)) throw fail(400, 'WHATSAPP_INPUT_INVALID', 'Settings must be an object.');
    const previous = account(), old = configuration(previous), next = { ...old };
    for (const field of ['phoneNumberId', 'businessAccountId']) if (body[field] !== undefined) {
      if (typeof body[field] !== 'string' || !/^\d{3,32}$/.test(body[field])) throw fail(400, 'WHATSAPP_INPUT_INVALID', 'Enter the numeric Meta phone number ID and WhatsApp business account ID.');
      next[field] = body[field];
    }
    if (body.apiVersion !== undefined) { if (!/^v[2-9]\d\.0$/.test(body.apiVersion)) throw fail(400, 'WHATSAPP_INPUT_INVALID', 'Use a supported Graph API version such as v26.0.'); next.apiVersion = body.apiVersion; }
    for (const [field, min, max] of [['dailyLimit', 1, 1000], ['hourlyLimit', 1, 100], ['minIntervalSeconds', 1, 3600]]) if (body[field] !== undefined) {
      if (!Number.isInteger(body[field]) || body[field] < min || body[field] > max) throw fail(400, 'WHATSAPP_INPUT_INVALID', `${field} must be between ${min} and ${max}.`);
      next[field] = body[field];
    }
    if (body.paused !== undefined) { if (typeof body.paused !== 'boolean') throw fail(400, 'WHATSAPP_INPUT_INVALID', 'Paused must be true or false.'); next.paused = body.paused; }
    const identityUnchanged = ['phoneNumberId', 'businessAccountId', 'apiVersion'].every((k) => next[k] === old[k]);
    let secret = identityUnchanged ? previous?.secret || null : null;
    const tokenChanged = typeof body.accessToken === 'string' && body.accessToken.length > 0;
    if (body.accessToken !== undefined && body.accessToken !== '') {
      if (typeof body.accessToken !== 'string' || body.accessToken.length < 20 || body.accessToken.length > 8192 || /\s|[\x00-\x1f\x7f]/.test(body.accessToken)) throw fail(400, 'WHATSAPP_TOKEN_INVALID', 'Enter a valid Meta access token.');
      try { secret = vault.seal(body.accessToken, 'whatsapp-account'); } catch { throw fail(409, 'WHATSAPP_KEY_UNAVAILABLE', 'The connection could not be saved securely.'); }
    }
    const changed = !previous || JSON.stringify(next) !== JSON.stringify(old) || tokenChanged;
    if (!changed) return getSettings();
    const pauseOnly = previous && !tokenChanged && Object.keys(next).every((key) => key === 'paused' || next[key] === old[key]);
    const revision = pauseOnly ? previous.revision : uid(), verified = identityUnchanged && !tokenChanged && previous?.verified ? 1 : 0;
    tx(() => {
      db.prepare(`INSERT INTO whatsapp_account(id,config_json,secret,revision,verified,metadata_json,updated_at) VALUES(1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,secret=excluded.secret,revision=excluded.revision,verified=excluded.verified,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`).run(JSON.stringify(next), secret, revision, verified, verified ? previous.metadata_json : '{}', now());
      // Any settings change invalidates a reviewed queue. Changing limits cannot bypass it.
      if (!pauseOnly || next.paused) db.prepare("UPDATE whatsapp_batches SET status='paused',hold_reason=?,updated_at=? WHERE status IN ('queued','sending')").run(pauseOnly ? 'WhatsApp sending paused. Explicitly resume this batch after unpausing.' : 'Settings changed. Cancel and review a new batch.',now());
    });
    return getSettings();
  }
  function disconnect() {
    tx(() => {
      businessInbox.clearWebhookConfiguration();
      db.prepare("UPDATE whatsapp_batches SET status='cancelled',updated_at=?,hold_reason='WhatsApp account disconnected.' WHERE status IN ('queued','sending','paused')").run(now());
      db.prepare("UPDATE whatsapp_outbox SET status='cancelled',updated_at=?,error_code='WHATSAPP_DISCONNECTED',error_message='WhatsApp account disconnected.' WHERE status='queued'").run(now());
      db.prepare('DELETE FROM whatsapp_account WHERE id=1').run();
      db.prepare('DELETE FROM whatsapp_templates').run();
    });
    return getSettings();
  }
  function credentials(requireVerified = true) {
    const row = account(); if (!row?.secret || (requireVerified && !row.verified)) throw fail(409, 'WHATSAPP_NOT_CONNECTED', 'Save and verify a WhatsApp Business API account first.');
    let token; try { token = vault.open(row.secret, 'whatsapp-account'); } catch { throw fail(409, 'WHATSAPP_KEY_UNAVAILABLE', 'Reconnect the WhatsApp account to unlock its credentials.'); }
    return { row, config: configuration(row), token };
  }
  async function request(connection, path, { query = {}, body } = {}) {
    const url = new URL(`https://graph.facebook.com/${connection.config.apiVersion}/${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    let response;
    try { response = await fetchFn(url.href, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${connection.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(20000) }); }
    catch { throw fail(502, body ? 'WHATSAPP_SUBMISSION_UNKNOWN' : 'WHATSAPP_CONNECTION_FAILED', body ? 'The provider response was not received. The outcome is unknown; do not resend this message.' : 'Meta could not be reached. Check the connection and try again.'); }
    let data; try { data = await response.json(); } catch { throw fail(502, body ? 'WHATSAPP_SUBMISSION_UNKNOWN' : 'WHATSAPP_RESPONSE_INVALID', 'Meta returned an unreadable response.'); }
    if (!response.ok || data?.error) {
      const code = Number(data?.error?.code);
      const knownRejected = response.status >= 400 && response.status < 500 && response.status !== 408;
      const error = fail(body && !knownRejected ? 502 : 400, body && !knownRejected ? 'WHATSAPP_SUBMISSION_UNKNOWN' : 'WHATSAPP_PROVIDER_REJECTED', body ? (knownRejected ? 'Meta rejected this submission. Check the business account, template and recipient in WhatsApp Manager.' : 'Meta did not confirm the submission. Its outcome is unknown; do not resend it.') : 'Meta could not verify these settings. Check the IDs, token permissions and account access.');
      if (Number.isSafeInteger(code) && code >= 0) error.providerCode = code;
      throw error;
    }
    return data;
  }
  async function collection(connection, path, fields) {
    const rows = [], cursors = new Set(); let after;
    for (let page = 0; page < 20; page++) {
      const data = await request(connection, path, { query: { fields, limit: 100, ...(after ? { after } : {}) } });
      if (!Array.isArray(data?.data)) throw fail(502, 'WHATSAPP_RESPONSE_INVALID', 'Meta returned an invalid list.');
      rows.push(...data.data);
      if (!data.paging?.next) return rows;
      // Never follow next URLs: they may contain credentials or point at another host.
      after = data.paging?.cursors?.after;
      if (typeof after !== 'string' || !after || after.length > 2000 || cursors.has(after)) throw fail(502, 'WHATSAPP_RESPONSE_INVALID', 'Meta returned invalid pagination.');
      cursors.add(after);
    }
    throw fail(409, 'WHATSAPP_LIST_TOO_LARGE', 'This account has too many results to load safely.');
  }
  async function verifyConnection() {
    const connection = credentials(false);
    db.prepare('UPDATE whatsapp_account SET verified=0 WHERE id=1 AND revision=?').run(connection.row.revision);
    const phones = await collection(connection, `${connection.config.businessAccountId}/phone_numbers`, 'id,display_phone_number,verified_name,quality_rating,code_verification_status');
    assertRevision(connection.row.revision);
    const phone = phones.find((p) => String(p.id) === connection.config.phoneNumberId);
    if (!phone) throw fail(400, 'WHATSAPP_PHONE_NOT_IN_ACCOUNT', 'This phone number ID does not belong to the selected WhatsApp business account.');
    if (phone.code_verification_status !== 'VERIFIED') throw fail(409, 'WHATSAPP_PHONE_NOT_VERIFIED', 'Verify this business phone number in WhatsApp Manager first.');
    const metadata = { displayPhoneNumber: safeText(phone.display_phone_number, 'Business number', 100, true), verifiedName: safeText(phone.verified_name || '', 'Business name', 300), qualityRating: ['GREEN','YELLOW','RED','UNKNOWN'].includes(phone.quality_rating) ? phone.quality_rating : 'UNKNOWN', verifiedAt: now() };
    db.prepare('UPDATE whatsapp_account SET verified=1,metadata_json=?,updated_at=? WHERE id=1 AND revision=?').run(JSON.stringify(metadata), now(), connection.row.revision);
    return getSettings();
  }
  function listTemplates() {
    const revision = account()?.revision;
    const rows = revision ? db.prepare('SELECT template_json,updated_at FROM whatsapp_templates WHERE account_revision=? ORDER BY id').all(revision) : [];
    return { rows: rows.map((r) => json(r.template_json)), updatedAt: rows[0]?.updated_at || null };
  }
  async function syncTemplates() {
    const connection = credentials();
    const raw = await collection(connection, `${connection.config.businessAccountId}/message_templates`, 'id,name,language,status,category,components,parameter_format');
    assertRevision(connection.row.revision);
    const rows = raw.filter((r) => r.status === 'APPROVED').map(normalizeWhatsAppTemplate);
    tx(() => {
      db.prepare('DELETE FROM whatsapp_templates').run();
      const insert = db.prepare('INSERT INTO whatsapp_templates(id,account_revision,template_json,updated_at) VALUES(?,?,?,?)');
      for (const row of rows) insert.run(row.id, connection.row.revision, JSON.stringify(row), now());
    });
    return { rows, updatedAt: now() };
  }
  function assertLead(placeId, expected) {
    const lead = getLead(placeId);
    if (!lead) throw fail(404, 'WHATSAPP_LEAD_MISSING', 'This business is unavailable or in Trash.');
    if (lead.lead_status === 'not_interested' || getPreview(placeId).preview.stage === 'lost') throw fail(409, 'WHATSAPP_RECIPIENT_BLOCKED', 'This business has opted out or its opportunity is lost.');
    const number = leadNumber(lead);
    if (expected && (number !== expected.number || lead.name !== expected.businessName)) throw fail(409, 'WHATSAPP_LEAD_CHANGED', 'The business name or phone number changed. Review a new batch.');
    if (db.prepare('SELECT 1 FROM whatsapp_suppressions WHERE number=?').get(number)) throw fail(409, 'WHATSAPP_RECIPIENT_BLOCKED', 'This number has withdrawn WhatsApp permission.');
    return { lead, number };
  }
  const consentView = (row) => ({ placeId: row.place_id, number: row.number, optedIn: !!row.opted_in, evidence: row.evidence, updatedAt: row.updated_at });
  function listConsents({ placeId, placeIds } = {}) {
    const waba = configuration().businessAccountId;
    const ids = placeId ? [String(placeId)] : String(placeIds || '').split(',').filter(Boolean).slice(0,25);
    const rows = db.prepare(`SELECT * FROM whatsapp_consents WHERE business_account_id=? ${ids.length ? `AND place_id IN (${ids.map(() => '?').join(',')})` : ''} ORDER BY updated_at DESC LIMIT 200`).all(waba,...ids);
    return { rows: rows.map(consentView) };
  }
  function listSuppressions({ number, numbers } = {}) {
    const selected = number ? [normalizeWhatsAppNumber(number)] : numbers ? String(numbers).split(',').map(normalizeWhatsAppNumber) : [];
    if (selected.length > 25) throw fail(400, 'WHATSAPP_BATCH_INVALID', 'Check up to 25 numbers at a time.');
    return { rows: db.prepare(`SELECT number,reason,updated_at AS updatedAt FROM whatsapp_suppressions ${selected.length ? `WHERE number IN (${selected.map(() => '?').join(',')})` : ''} ORDER BY updated_at DESC LIMIT 1000`).all(...selected) };
  }
  function saveConsent(placeId, body = {}) {
    const lead = getLead(placeId); if (!lead) throw fail(404, 'WHATSAPP_LEAD_MISSING', 'This business is unavailable or in Trash.');
    const number = normalizeWhatsAppNumber(body.number), waba = configuration().businessAccountId;
    if (!waba) throw fail(409, 'WHATSAPP_NOT_CONNECTED', 'Save a WhatsApp business account before recording permission.');
    if (body.confirmed !== true || typeof body.optedIn !== 'boolean') throw fail(400, 'WHATSAPP_CONSENT_CONFIRMATION_REQUIRED', 'Confirm the recipient permission decision.');
    if (number !== leadNumber(lead)) throw fail(409, 'WHATSAPP_LEAD_CHANGED', 'The number no longer matches this business.');
    const evidence = safeText(body.evidence || '', 'Permission evidence', 2000, body.optedIn);
    if (body.optedIn && (lead.lead_status === 'not_interested' || getPreview(placeId).preview.stage === 'lost')) throw fail(409, 'WHATSAPP_RECIPIENT_BLOCKED', 'Resolve the business opt-out or lost status before recording renewed permission.');
    tx(() => {
      db.prepare('INSERT INTO whatsapp_consents(place_id,number,business_account_id,opted_in,evidence,revision,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(place_id,number,business_account_id) DO UPDATE SET opted_in=excluded.opted_in,evidence=excluded.evidence,revision=excluded.revision,updated_at=excluded.updated_at').run(placeId,number,waba,body.optedIn ? 1 : 0,evidence,uid(),now());
      db.prepare('INSERT INTO whatsapp_consent_events(id,place_id,number,business_account_id,opted_in,evidence,created_at) VALUES(?,?,?,?,?,?,?)').run(uid(),placeId,number,waba,body.optedIn ? 1 : 0,evidence,now());
      if (body.optedIn) db.prepare('DELETE FROM whatsapp_suppressions WHERE number=?').run(number);
      else {
        db.prepare('INSERT INTO whatsapp_suppressions(number,reason,updated_at) VALUES(?,?,?) ON CONFLICT(number) DO UPDATE SET reason=excluded.reason,updated_at=excluded.updated_at').run(number,'Recipient withdrew WhatsApp permission.',now());
        db.prepare("UPDATE whatsapp_consents SET opted_in=0,revision=?,updated_at=? WHERE number=?").run(uid(),now(),number);
        db.prepare("UPDATE whatsapp_outbox SET status='cancelled',error_code='WHATSAPP_PERMISSION_REVOKED',error_message='Recipient withdrew WhatsApp permission.',updated_at=? WHERE number=? AND status='queued'").run(now(),number);
      }
    });
    return consentView(db.prepare('SELECT * FROM whatsapp_consents WHERE place_id=? AND number=? AND business_account_id=?').get(placeId,number,waba));
  }
  function consentFor(placeId, number, waba, revision) {
    const row = db.prepare('SELECT * FROM whatsapp_consents WHERE place_id=? AND number=? AND business_account_id=?').get(placeId,number,waba);
    if (!row?.opted_in || (revision && row.revision !== revision)) throw fail(409, 'WHATSAPP_OPT_IN_REQUIRED', 'Record current WhatsApp opt-in for this business and exact number before reviewing.');
    return row;
  }
  function assertNoOutstanding(message, businessAccountId, excludeId) {
    const rows = db.prepare("SELECT id,snapshot_json FROM whatsapp_outbox WHERE number=? AND status IN ('queued','sending','unknown')").all(message.number);
    if (rows.some((row) => {
      if (row.id === excludeId) return false;
      const existing = json(row.snapshot_json, {});
      return existing.businessAccountId === businessAccountId && hash(existing.payload || {}) === hash(message.payload);
    })) throw fail(409, 'WHATSAPP_DUPLICATE_SUBMISSION', 'This exact message is already queued, being submitted, or has an unknown outcome. Review its history; do not submit it again.');
  }
  async function prepareBatch(body = {}) {
    const connection = credentials(), revision = connection.row.revision;
    if (!Array.isArray(body.recipients) || body.recipients.length < 1 || body.recipients.length > 25) throw fail(400, 'WHATSAPP_BATCH_INVALID', 'Choose between 1 and 25 businesses.');
    const templates = await syncTemplates(); assertRevision(revision);
    const template = templates.rows.find((t) => t.id === body.templateId);
    if (!template?.supported) throw fail(409, 'WHATSAPP_TEMPLATE_UNAVAILABLE', template?.unsupportedReason || 'Select an approved supported template.');
    const numbers = new Set(), ids = new Set();
    const messages = body.recipients.map((recipient) => {
      if (!plainObject(recipient) || typeof recipient.placeId !== 'string') throw fail(400, 'WHATSAPP_BATCH_INVALID', 'Each recipient needs a saved business.');
      const { lead, number } = assertLead(recipient.placeId);
      if (recipient.number !== undefined && normalizeWhatsAppNumber(recipient.number) !== number) throw fail(409, 'WHATSAPP_LEAD_CHANGED', 'The phone number changed.');
      if (numbers.has(number) || ids.has(lead.place_id)) throw fail(400, 'WHATSAPP_DUPLICATE_RECIPIENT', 'Each business and phone number may appear only once in a batch.');
      numbers.add(number); ids.add(lead.place_id);
      const consent = consentFor(lead.place_id,number,connection.config.businessAccountId);
      const rendered = renderWhatsAppTemplate(template,recipient.parameters || {});
      const { components, ...display } = rendered;
      const message = { placeId: lead.place_id, businessName: lead.name, number, ...display, consentRevision: consent.revision, templateId: template.id, templateFingerprint: template.fingerprint,
        payload: { messaging_product: 'whatsapp', recipient_type: 'individual', to: number, type: 'template', template: { name: template.name, language: { code: template.language }, ...(components.length ? { components } : {}) } } };
      assertNoOutstanding(message,connection.config.businessAccountId);
      return message;
    });
    const sender = { displayPhoneNumber: getSettings().displayPhoneNumber, verifiedName: getSettings().verifiedName };
    const snapshot = { accountRevision: revision, businessAccountId: connection.config.businessAccountId, sender, template: { id: template.id, name: template.name, language: template.language }, messages };
    const reviewToken = crypto.randomBytes(32).toString('base64url'), confirmationDigest = hash(snapshot), expiresAt = now() + 15*60*1000;
    db.prepare('INSERT INTO whatsapp_reviews(token_hash,snapshot_json,digest,expires_at,created_at) VALUES(?,?,?,?,?)').run(hash(reviewToken),JSON.stringify(snapshot),confirmationDigest,expiresAt,now());
    return { reviewToken, confirmationDigest, expiresAt, sender, template: snapshot.template, messages: messages.map(publicSnapshot), limits: { dailyLimit: connection.config.dailyLimit, hourlyLimit: connection.config.hourlyLimit, minIntervalSeconds: connection.config.minIntervalSeconds } };
  }
  function publicSnapshot(snapshot) { const { payload, consentRevision, templateFingerprint, ...display } = snapshot; return display; }
  function rowView(row) { return { ...publicSnapshot(json(row.snapshot_json, {})), id: row.id, batchId: row.batch_id, placeId: row.place_id, number: row.number, status: row.status, providerMessageId: row.provider_message_id, attemptedAt: row.attempted_at, acceptedAt: row.accepted_at, errorCode: row.error_code, error: row.error_message, createdAt: row.created_at, updatedAt: row.updated_at, tracking: 'acceptance_only' }; }
  function getBatch(id) {
    const batch = db.prepare('SELECT * FROM whatsapp_batches WHERE id=?').get(String(id));
    if (!batch) throw fail(404, 'WHATSAPP_BATCH_MISSING', 'This WhatsApp batch was not found.');
    const rows = db.prepare('SELECT * FROM whatsapp_outbox WHERE batch_id=? ORDER BY created_at,id').all(batch.id).map(rowView);
    const counts = { total: rows.length, queued: 0, sending: 0, accepted: 0, failed: 0, unknown: 0, cancelled: 0 };
    for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
    const review = json(db.prepare('SELECT snapshot_json FROM whatsapp_reviews WHERE token_hash=?').get(batch.review_hash)?.snapshot_json, {});
    return { id: batch.id, status: batch.status, idempotencyKey: batch.idempotency_key, sender: review.sender || null, template: review.template || null, rows, counts, nextAttemptAt: batch.next_attempt_at, holdReason: batch.hold_reason, createdAt: batch.created_at, updatedAt: batch.updated_at };
  }
  function listBatches({ idempotencyKey } = {}) { return { rows: db.prepare(`SELECT id FROM whatsapp_batches ${idempotencyKey ? 'WHERE idempotency_key=?' : ''} ORDER BY created_at DESC LIMIT 50`).all(...(idempotencyKey ? [String(idempotencyKey)] : [])).map((r) => getBatch(r.id)) }; }
  function listMessages({ placeId, batchId } = {}) {
    const clauses = [], args = []; if (placeId) { clauses.push('place_id=?'); args.push(String(placeId)); } if (batchId) { clauses.push('batch_id=?'); args.push(String(batchId)); }
    return { rows: db.prepare(`SELECT * FROM whatsapp_outbox ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC,id LIMIT 200`).all(...args).map(rowView) };
  }
  function checkSnapshot(snapshot) {
    const row = assertRevision(snapshot.accountRevision); if (!row.verified) throw fail(409, 'WHATSAPP_NOT_CONNECTED', 'Verify the WhatsApp business account.');
    for (const message of snapshot.messages) { assertLead(message.placeId,message); consentFor(message.placeId,message.number,snapshot.businessAccountId,message.consentRevision); }
  }
  function sendBatch(body = {}) {
    safeText(body.idempotencyKey, 'Submission key', 150, true);
    if (typeof body.reviewToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.reviewToken)) throw fail(400, 'WHATSAPP_REVIEW_REQUIRED', 'Review the final batch before sending.');
    const reviewHash = hash(body.reviewToken), existing = db.prepare('SELECT * FROM whatsapp_batches WHERE idempotency_key=?').get(body.idempotencyKey);
    if (existing) { if (existing.review_hash !== reviewHash) throw fail(409, 'WHATSAPP_IDEMPOTENCY_CONFLICT', 'This submission key belongs to a different reviewed batch.'); return { batch: getBatch(existing.id) }; }
    if (body.confirmed !== true) throw fail(400, 'WHATSAPP_CONFIRMATION_REQUIRED', 'Confirm this exact reviewed batch before sending.');
    const review = db.prepare('SELECT * FROM whatsapp_reviews WHERE token_hash=?').get(reviewHash);
    if (!review || review.expires_at <= now()) throw fail(409, 'WHATSAPP_REVIEW_EXPIRED', 'The review expired. Prepare and check a new batch.');
    if (review.consumed_batch_id) throw fail(409, 'WHATSAPP_REVIEW_USED', 'This review was already submitted. Open its batch history.');
    if (body.confirmationDigest !== review.digest) throw fail(409, 'WHATSAPP_REVIEW_CHANGED', 'The reviewed batch does not match this confirmation.');
    const snapshot = json(review.snapshot_json); checkSnapshot(snapshot);
    for (const message of snapshot.messages) assertNoOutstanding(message,snapshot.businessAccountId);
    if (configuration().paused) throw fail(409, 'WHATSAPP_PAUSED', 'WhatsApp API sending is paused in settings.');
    const id = uid();
    tx(() => {
      db.prepare('INSERT INTO whatsapp_batches(id,idempotency_key,review_hash,status,next_attempt_at,created_at,updated_at) VALUES(?,?,?,\'queued\',?,?,?)').run(id,body.idempotencyKey,reviewHash,now(),now(),now());
      const insert = db.prepare('INSERT INTO whatsapp_outbox(id,batch_id,place_id,number,status,snapshot_json,account_revision,created_at,updated_at) VALUES(?,?,?,?,\'queued\',?,?,?,?)');
      for (const [index,message] of snapshot.messages.entries()) insert.run(uid(),id,message.placeId,message.number,JSON.stringify({ ...message, businessAccountId: snapshot.businessAccountId }),snapshot.accountRevision,now()+index,now());
      db.prepare('UPDATE whatsapp_reviews SET consumed_batch_id=? WHERE token_hash=?').run(id,reviewHash);
    });
    if (timer) queueMicrotask(() => tick().catch(() => {}));
    return { batch: getBatch(id) };
  }
  function cancelBatch(id) {
    getBatch(id);
    tx(() => { db.prepare("UPDATE whatsapp_batches SET status='cancelled',hold_reason='Remaining submissions cancelled.',next_attempt_at=NULL,updated_at=? WHERE id=? AND status NOT IN ('completed','cancelled')").run(now(),id); db.prepare("UPDATE whatsapp_outbox SET status='cancelled',error_code='WHATSAPP_CANCELLED',error_message='Cancelled before submission.',updated_at=? WHERE batch_id=? AND status='queued'").run(now(),id); });
    return { batch: getBatch(id) };
  }
  function resumeBatch(id, body = {}) {
    const batch = getBatch(id); if (body.confirmed !== true) throw fail(400, 'WHATSAPP_CONFIRMATION_REQUIRED', 'Confirm resuming the remaining reviewed submissions.');
    if (batch.status !== 'paused') throw fail(409, 'WHATSAPP_BATCH_NOT_PAUSED', 'Only a paused batch can be resumed.');
    const raw = db.prepare('SELECT review_hash FROM whatsapp_batches WHERE id=?').get(id);
    const snapshot = json(db.prepare('SELECT snapshot_json FROM whatsapp_reviews WHERE token_hash=?').get(raw.review_hash)?.snapshot_json);
    checkSnapshot({ ...snapshot, messages: snapshot.messages.filter((m) => batch.rows.some((r) => r.placeId === m.placeId && r.status === 'queued')) });
    if (configuration().paused) throw fail(409, 'WHATSAPP_PAUSED', 'WhatsApp API sending is paused in settings.');
    db.prepare("UPDATE whatsapp_batches SET status='queued',hold_reason=NULL,next_attempt_at=?,updated_at=? WHERE id=?").run(now(),now(),id);
    if (timer) queueMicrotask(() => tick().catch(() => {}));
    return { batch: getBatch(id) };
  }
  function nextAllowedAt(config) {
    const attempts = db.prepare('SELECT attempted_at FROM whatsapp_outbox WHERE attempted_at>? ORDER BY attempted_at DESC').all(now()-86400000).map((r) => r.attempted_at);
    const hourly = attempts.filter((n) => n > now()-3600000);
    return Math.max(now(),attempts.length ? attempts[0]+config.minIntervalSeconds*1000 : 0,attempts.length >= config.dailyLimit ? attempts[config.dailyLimit-1]+86400000 : 0,hourly.length >= config.hourlyLimit ? hourly[config.hourlyLimit-1]+3600000 : 0);
  }
  function settleBatch(id) {
    const batch = getBatch(id);
    if (!batch.counts.queued && !batch.counts.sending && !['cancelled','completed'].includes(batch.status)) db.prepare("UPDATE whatsapp_batches SET status='completed',next_attempt_at=NULL,hold_reason=NULL,updated_at=? WHERE id=?").run(now(),id);
    else if (batch.status === 'sending') db.prepare("UPDATE whatsapp_batches SET status='queued',updated_at=? WHERE id=?").run(now(),id);
  }
  async function processNext() {
    if (configuration().paused) return;
    if (db.prepare("SELECT 1 FROM whatsapp_outbox WHERE status='sending' LIMIT 1").get()) return;
    const row = db.prepare("SELECT o.* FROM whatsapp_outbox o JOIN whatsapp_batches b ON b.id=o.batch_id WHERE o.status='queued' AND b.status IN ('queued','sending') AND COALESCE(b.next_attempt_at,0)<=? ORDER BY b.created_at,o.created_at,o.id LIMIT 1").get(now());
    if (!row) { for (const batch of db.prepare("SELECT id FROM whatsapp_batches WHERE status IN ('queued','sending')").all()) settleBatch(batch.id); return; }
    const due = nextAllowedAt(configuration());
    if (due > now()) { db.prepare('UPDATE whatsapp_batches SET next_attempt_at=?,hold_reason=? WHERE id=?').run(due,'Waiting for the configured sending limits.',row.batch_id); return; }
    const snapshot = json(row.snapshot_json); let submitted = false;
    try {
      // Claim before any asynchronous work; duplicate ticks cannot submit the same row.
      const claimed = db.prepare("UPDATE whatsapp_outbox SET status='sending',updated_at=? WHERE id=? AND status='queued'").run(now(),row.id);
      if (!claimed.changes) return;
      db.prepare("UPDATE whatsapp_batches SET status='sending',hold_reason=NULL,updated_at=? WHERE id=?").run(now(),row.batch_id);
      assertRevision(row.account_revision);
      assertLead(row.place_id,snapshot); consentFor(row.place_id,row.number,snapshot.businessAccountId,snapshot.consentRevision);
      assertNoOutstanding(snapshot,snapshot.businessAccountId,row.id);
      const templates = await syncTemplates();
      const current = templates.rows.find((t) => t.id === snapshot.templateId);
      if (!current?.supported || current.fingerprint !== snapshot.templateFingerprint) throw fail(409, 'WHATSAPP_TEMPLATE_CHANGED', 'The approved template changed or is unavailable. Cancel the remaining batch and review it again.');
      const connection = credentials(); assertRevision(row.account_revision);
      if (configuration().paused || !['queued','sending'].includes(getBatch(row.batch_id).status)) throw fail(409, 'WHATSAPP_CANCELLED', 'This batch was paused or cancelled before submission.');
      // Recheck mutable recipient state after every provider preflight and immediately before POST.
      assertLead(row.place_id,snapshot); consentFor(row.place_id,row.number,snapshot.businessAccountId,snapshot.consentRevision);
      db.prepare('UPDATE whatsapp_outbox SET attempted_at=?,updated_at=? WHERE id=?').run(now(),now(),row.id);
      submitted = true;
      const response = await request(connection,`${connection.config.phoneNumberId}/messages`,{ body: snapshot.payload });
      const providerId = response?.messages?.length === 1 && response.messages[0]?.id;
      if (typeof providerId !== 'string' || !/^wamid\.[A-Za-z0-9_+/=.-]{1,1000}$/.test(providerId)) throw fail(502,'WHATSAPP_SUBMISSION_UNKNOWN','Meta did not return a recognizable message receipt. Do not resend this message.');
      tx(() => {
        db.prepare("UPDATE whatsapp_outbox SET status='accepted',provider_message_id=?,accepted_at=?,updated_at=?,error_code=NULL,error_message=NULL WHERE id=?").run(providerId,now(),now(),row.id);
        recordActivityFn(row.place_id,{ kind:'sent',channel:'whatsapp',message:snapshot.text,idempotencyKey:`wa-api:${row.id}` },{ transaction:false, providerAccepted:true });
      });
    } catch (error) {
      const unknown = submitted && (!error.whatsappSafe || error.code === 'WHATSAPP_SUBMISSION_UNKNOWN');
      const cancelled = !submitted && ['WHATSAPP_CANCELLED','WHATSAPP_RECIPIENT_BLOCKED','WHATSAPP_LEAD_MISSING','WHATSAPP_OPT_IN_REQUIRED'].includes(error.code);
      db.prepare('UPDATE whatsapp_outbox SET status=?,error_code=?,error_message=?,updated_at=? WHERE id=?').run(unknown ? 'unknown' : cancelled ? 'cancelled' : 'failed',unknown ? 'WHATSAPP_SUBMISSION_UNKNOWN' : error.whatsappSafe ? error.code : 'WHATSAPP_OPERATION_FAILED',unknown ? 'Submission outcome is unknown. Check WhatsApp Manager before considering any new message.' : error.whatsappSafe ? error.message : 'The message could not be submitted.',now(),row.id);
      if (unknown || ['WHATSAPP_ACCOUNT_CHANGED','WHATSAPP_TEMPLATE_CHANGED','WHATSAPP_NOT_CONNECTED','WHATSAPP_PROVIDER_REJECTED','WHATSAPP_CONNECTION_FAILED','WHATSAPP_RESPONSE_INVALID'].includes(error.code)) db.prepare("UPDATE whatsapp_batches SET status='paused',hold_reason=?,updated_at=? WHERE id=? AND status!='cancelled'").run(unknown ? 'A submission has an unknown outcome. Review history before resuming remaining recipients.' : 'Review the account or approved template before resuming remaining recipients.',now(),row.batch_id);
    } finally { settleBatch(row.batch_id); }
  }
  function tick() {
    if (ticking) return ticking;
    ticking = processNext().finally(() => { ticking = null; }); return ticking;
  }
  function recoverInterrupted() {
    if (recovered) return; recovered = true;
    tx(() => {
      db.prepare("UPDATE whatsapp_outbox SET status='unknown',error_code='WHATSAPP_INTERRUPTED',error_message='The app stopped during submission. Do not retry this message.',updated_at=? WHERE status='sending'").run(now());
      db.prepare("UPDATE whatsapp_batches SET status='paused',hold_reason='The app restarted. Review history and explicitly resume remaining recipients.',updated_at=? WHERE status IN ('queued','sending')").run(now());
    });
  }
  function startWorker() { if (timer) return; recoverInterrupted(); timer = setInterval(() => tick().catch(() => {}),1000); timer.unref(); }
  function stopWorker() { if (timer) clearInterval(timer); timer = null; }
  const businessInbox = createWhatsAppBusinessInbox({
    getAccount: () => { const row = account(); return { ...configuration(row), revision: row?.revision || '', configured: Boolean(row?.secret), verified: Boolean(row?.verified) }; },
    credentials, request, vault, now, recordActivityFn,
  });
  const service = { businessInbox,getSettings,saveSettings,verifyConnection,disconnect,listTemplates,syncTemplates,listConsents,listSuppressions,saveConsent,prepareBatch,sendBatch,getBatch,listBatches,listMessages,cancelBatch,resumeBatch,tick,startWorker,stopWorker,recoverInterrupted };
  if (autoStart) startWorker();
  return service;
}

export const whatsappService = createWhatsAppService();
