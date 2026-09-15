import crypto from 'node:crypto';
import { db } from './db.js';
import { integrationService } from './integrations.js';
import { smsService, normalizeSmsNumber } from './sms.js';

db.exec(`CREATE TABLE IF NOT EXISTS sms_batches (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
 provider TEXT NOT NULL, connection_revision TEXT NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL,
 status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sms_batch_recipients (
 batch_id TEXT NOT NULL REFERENCES sms_batches(id), position INTEGER NOT NULL, number TEXT NOT NULL, place_id TEXT,
 status TEXT NOT NULL DEFAULT 'pending', message_id TEXT, error TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(batch_id,position), UNIQUE(batch_id,number)
);`);
const fail = (status, message) => Object.assign(new Error(message), { status, smsSafe: true });
const hash = data => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
export function createSmsBatchService({ sms = smsService, integrations = integrationService, now = Date.now, simulated = false, recoverInterrupted = false } = {}) {
  let timer, working = false;
  if (recoverInterrupted) db.prepare("UPDATE sms_batches SET status='paused',error='Server restarted. Review progress before resuming.' WHERE status='running'").run();
  const row = id => db.prepare('SELECT * FROM sms_batches WHERE id=?').get(id);
  const recipients = id => db.prepare('SELECT * FROM sms_batch_recipients WHERE batch_id=? ORDER BY position').all(id);
  function ineligible(entry) {
    if (db.prepare('SELECT 1 FROM sms_suppressions WHERE number=?').get(entry.number)) return 'SMS blocked';
    if (entry.placeId || entry.place_id) {
      const lead = db.prepare('SELECT phone_e164,whatsapp,deleted_at,lead_status FROM businesses WHERE place_id=?').get(entry.placeId || entry.place_id);
      if (!lead || lead.deleted_at) return 'Business unavailable';
      if (lead.lead_status === 'not_interested') return 'Not interested';
      if (![lead.phone_e164, lead.whatsapp].includes(entry.number)) return 'Phone number changed';
    }
    return '';
  }
  function preview(input = {}) {
    if (!['twilio', 'telnyx', 'vonage'].includes(input.provider)) throw fail(400, 'Choose an SMS provider.');
    const connection = integrations.status(input.provider);
    if (!connection.verified) throw fail(409, 'Verify this SMS connection first.');
    if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 1600 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.body)) throw fail(400, 'Write a message of up to 1,600 characters.');
    if (!Array.isArray(input.recipients) || !input.recipients.length || input.recipients.length > 1000) throw fail(400, 'Choose between 1 and 1,000 SMS recipients.');
    const seen = new Set(), normalized = [], excluded = []; let duplicates = 0;
    for (const candidate of input.recipients) {
      const number = normalizeSmsNumber(typeof candidate === 'string' ? candidate : candidate?.number);
      if (seen.has(number)) { duplicates++; continue; } seen.add(number);
      const placeId = typeof candidate === 'object' ? candidate.placeId : undefined;
      if (placeId != null && (typeof placeId !== 'string' || !placeId || placeId.length > 300)) throw fail(400, 'A business reference is invalid.');
      const entry = { number, ...(placeId ? { placeId } : {}) }, reason = ineligible(entry);
      if (reason) excluded.push({ number, reason }); else normalized.push(entry);
    }
    if (!normalized.length) throw fail(400, 'No eligible SMS recipients remain.');
    return { provider: input.provider, connectionRevision: connection.revision, sender: connection.metadata.fromNumber, body: input.body.trim(), recipients: normalized, duplicates, excluded, simulated };
  }
  function detail(id) {
    const batch = row(id); if (!batch) throw fail(404, 'SMS batch not found.');
    const entries = recipients(id), counts = {};
    for (const entry of entries) counts[entry.status] = (counts[entry.status] || 0) + 1;
    return { id, provider: batch.provider, sender: batch.sender, body: batch.body, status: batch.status, error: batch.error, createdAt: batch.created_at, total: entries.length, counts,
      recipients: entries.map(entry => ({ number: entry.number, status: entry.status, messageId: entry.message_id, error: entry.error })), simulated };
  }
  function create(input = {}) {
    if (input.confirmed !== true || input.consent !== true) throw fail(400, 'Confirm the batch and SMS permission for every recipient.');
    if (typeof input.requestId !== 'string' || !/^[\w-]{16,80}$/.test(input.requestId)) throw fail(400, 'A batch request ID is required.');
    const fingerprint = hash({ provider: input.provider, connectionRevision: input.connectionRevision, body: input.body, recipients: input.recipients });
    const previous = db.prepare('SELECT * FROM sms_batches WHERE request_id=?').get(input.requestId);
    if (previous) { if (previous.fingerprint !== fingerprint) throw fail(409, 'This request ID belongs to a different batch.'); return { ...detail(previous.id), duplicate: true }; }
    const reviewed = preview(input);
    if (input.connectionRevision !== reviewed.connectionRevision) throw fail(409, 'The sender changed. Review this batch again.');
    if (reviewed.duplicates || reviewed.excluded.length) throw fail(409, 'Recipients changed. Review this batch again.');
    const id = crypto.randomUUID(), timestamp = now();
    db.exec('SAVEPOINT sms_batch_create');
    try {
      db.prepare("INSERT INTO sms_batches(id,request_id,fingerprint,provider,connection_revision,sender,body,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'running',?,?)").run(id,input.requestId,fingerprint,reviewed.provider,reviewed.connectionRevision,reviewed.sender,reviewed.body,timestamp,timestamp);
      const insert = db.prepare('INSERT INTO sms_batch_recipients(batch_id,position,number,place_id) VALUES(?,?,?,?)');
      reviewed.recipients.forEach((entry, position) => insert.run(id, position, entry.number, entry.placeId || null));
      db.exec('RELEASE sms_batch_create');
    } catch (error) { db.exec('ROLLBACK TO sms_batch_create; RELEASE sms_batch_create'); throw error; }
    return detail(id);
  }
  function control(id, action) {
    const batch = row(id); if (!batch) throw fail(404, 'SMS batch not found.');
    if (!['pause','resume','cancel'].includes(action)) throw fail(400, 'Choose a valid queue action.');
    if (['completed','cancelled'].includes(batch.status)) throw fail(409, 'This batch is finished.');
    if (action === 'resume') {
      const connection = integrations.status(batch.provider);
      if (!connection.verified || connection.revision !== batch.connection_revision) throw fail(409, 'The sender changed. Cancel this queue and review a new batch.');
    }
    db.prepare("UPDATE sms_batches SET status=?,error='',updated_at=? WHERE id=?").run(action === 'resume' ? 'running' : action === 'pause' ? 'paused' : 'cancelled', now(), id);
    if (action === 'cancel') db.prepare("UPDATE sms_batch_recipients SET status='cancelled' WHERE batch_id=? AND status='pending'").run(id);
    return detail(id);
  }
  async function tick() {
    if (working) return; working = true;
    try {
      const batch = db.prepare("SELECT * FROM sms_batches WHERE status='running' ORDER BY created_at,id LIMIT 1").get();
      if (!batch) return;
      const entry = db.prepare("SELECT * FROM sms_batch_recipients WHERE batch_id=? AND status='pending' ORDER BY position LIMIT 1").get(batch.id);
      if (!entry) { db.prepare("UPDATE sms_batches SET status='completed',updated_at=? WHERE id=? AND status='running'").run(now(),batch.id); return; }
      // Reconcile a previous submission before checking whether it is still eligible.
      // Its provider outcome remains true even if a lead changed after submission.
      const prior = db.prepare('SELECT * FROM sms_messages WHERE request_id=?').get(`${batch.id}-${entry.position}`);
      if (prior) {
        db.prepare('UPDATE sms_batch_recipients SET status=?,message_id=?,error=? WHERE batch_id=? AND position=?').run(prior.status,prior.id,prior.error,batch.id,entry.position);
        if (['unknown','submitting','failed','undelivered'].includes(prior.status)) db.prepare("UPDATE sms_batches SET status='paused',error='A message needs review. Unsent recipients are paused.',updated_at=? WHERE id=? AND status='running'").run(now(),batch.id);
        return;
      }
      if (db.prepare('SELECT count(*) n FROM sms_messages WHERE created_at>?').get(now()-60000).n >= 10) return;
      const connection = integrations.status(batch.provider);
      if (!connection.verified || connection.revision !== batch.connection_revision) { db.prepare("UPDATE sms_batches SET status='paused',error='The sender connection changed.',updated_at=? WHERE id=?").run(now(),batch.id); return; }
      const reason = ineligible(entry);
      if (reason) { db.prepare("UPDATE sms_batch_recipients SET status='skipped',error=? WHERE batch_id=? AND position=?").run(reason,batch.id,entry.position); return; }
      try {
        const result = await sms.send({ provider: batch.provider, connectionRevision: batch.connection_revision, requestId: `${batch.id}-${entry.position}`, recipient: entry.number, body: batch.body, consent: true, confirmed: true });
        db.prepare('UPDATE sms_batch_recipients SET status=?,message_id=?,error=? WHERE batch_id=? AND position=?').run(result.message.status,result.message.id,result.message.error || '',batch.id,entry.position);
        if (['unknown','submitting','failed','undelivered'].includes(result.message.status)) db.prepare("UPDATE sms_batches SET status='paused',error='A message needs review. Unsent recipients are paused.',updated_at=? WHERE id=? AND status='running'").run(now(),batch.id);
      } catch (error) {
        if (error.status !== 429) db.prepare("UPDATE sms_batches SET status='paused',error=?,updated_at=? WHERE id=? AND status='running'").run(error.smsSafe || error.integrationSafe ? error.message : 'Queue paused. Review before resuming.',now(),batch.id);
      }
    } finally { working = false; }
  }
  function startWorker() { if (!timer) { timer = setInterval(() => { tick().catch(() => {}); }, 6500); timer.unref?.(); } }
  function stopWorker() { if (timer) clearInterval(timer); timer = null; }
  return { preview, create, detail, control, tick, startWorker, stopWorker, list: () => ({ rows: db.prepare('SELECT id FROM sms_batches ORDER BY created_at DESC LIMIT 50').all().map(batch => { const { recipients, ...summary } = detail(batch.id); return summary; }), simulated }) };
}
export const smsBatchService = createSmsBatchService({ recoverInterrupted: true });
