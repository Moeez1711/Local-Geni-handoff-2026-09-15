import { db, json, tx } from './db.js';

const DEFAULTS = Object.freeze({ dailyLimit: 25, hourlyLimit: 5, minIntervalSeconds: 120, requireOptOut: true, optOutText: "If you'd rather not hear from me, reply 'no thanks' and I won't follow up.", paused: false, requireMailboxVerification: false, revision: 1 });
db.exec(`
CREATE TABLE IF NOT EXISTS email_policy (id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS email_suppressions (email TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS email_send_reservations (idempotency_key TEXT PRIMARY KEY, email TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS email_reservation_time ON email_send_reservations(created_at);
CREATE TABLE IF NOT EXISTS email_verifications (email TEXT PRIMARY KEY, result TEXT NOT NULL, checked_at INTEGER NOT NULL);
`);

export const emailError = (status, code, message) => Object.assign(new Error(message), { status, code });
export function normalizeEmail(value) {
  if (typeof value !== 'string') throw emailError(400, 'INVALID_EMAIL', 'Enter one email address.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(email)) throw emailError(400, 'INVALID_EMAIL', 'Enter one valid email address, without a display name or extra recipients.');
  const [local] = email.split('@');
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) throw emailError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  return email;
}
export function getEmailPolicy() { return { ...DEFAULTS, ...json(db.prepare('SELECT config FROM email_policy WHERE id=1').get()?.config, {}) }; }
export function updateEmailPolicy(body = {}) {
  const next = getEmailPolicy();
  for (const [key, min, max] of [['dailyLimit', 1, 1000], ['hourlyLimit', 1, 100], ['minIntervalSeconds', 30, 3600]]) {
    if (body[key] !== undefined) {
      if (!Number.isInteger(body[key]) || body[key] < min || body[key] > max) throw emailError(400, 'INVALID_POLICY', `${key} must be a whole number from ${min} to ${max}.`);
      next[key] = body[key];
    }
  }
  if (next.hourlyLimit > next.dailyLimit) throw emailError(400, 'INVALID_POLICY', 'The hourly limit cannot exceed the daily limit.');
  for (const key of ['requireOptOut', 'paused', 'requireMailboxVerification']) if (body[key] !== undefined) {
    if (typeof body[key] !== 'boolean') throw emailError(400, 'INVALID_POLICY', 'Choose a valid sending rule.');
    next[key] = body[key];
  }
  if (body.optOutText !== undefined) {
    if (typeof body.optOutText !== 'string' || body.optOutText.trim().length < 10 || body.optOutText.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(body.optOutText)) throw emailError(400, 'INVALID_POLICY', 'Use a clear opt-out line between 10 and 500 characters.');
    next.optOutText = body.optOutText.trim();
  }
  next.revision += 1;
  db.prepare('INSERT INTO email_policy(id,config) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config').run(JSON.stringify(next));
  return getPolicyStatus();
}
export function prepareEmailText(text) {
  if (typeof text !== 'string') throw emailError(400, 'INVALID_MESSAGE', 'Write a message first.');
  const policy = getEmailPolicy();
  return policy.requireOptOut && !text.split(/\r?\n/).some((line) => line.trim() === policy.optOutText) ? `${text.trimEnd()}\n\n${policy.optOutText}` : text;
}
export function listSuppressions() { return db.prepare('SELECT email,reason,created_at AS createdAt FROM email_suppressions ORDER BY created_at DESC LIMIT 1000').all(); }
export function addSuppression({ email, reason = 'manual' } = {}) {
  email = normalizeEmail(email);
  if (!['manual', 'opt_out', 'bounced', 'replied', 'not_interested'].includes(reason)) throw emailError(400, 'INVALID_REASON', 'Choose a do-not-contact reason.');
  db.prepare('INSERT INTO email_suppressions VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at').run(email, reason, Date.now());
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_campaign_recipients'").get()) db.prepare("UPDATE email_campaign_recipients SET status='stopped',stop_reason=? WHERE lower(to_email)=? AND status='pending'").run(reason, email);
  return { email, reason };
}
export function removeSuppression(email) { db.prepare('DELETE FROM email_suppressions WHERE email=?').run(normalizeEmail(email)); return { ok: true }; }
export function getPolicyStatus(now = Date.now()) {
  const policy = getEmailPolicy();
  const daily = db.prepare('SELECT count(*) AS n FROM email_send_reservations WHERE created_at>?').get(now - 86400000).n;
  const hourly = db.prepare('SELECT count(*) AS n FROM email_send_reservations WHERE created_at>?').get(now - 3600000).n;
  const last = db.prepare('SELECT max(created_at) AS ts FROM email_send_reservations').get().ts || 0;
  const limits = [last ? last + policy.minIntervalSeconds * 1000 : 0];
  if (daily >= policy.dailyLimit) limits.push(db.prepare('SELECT created_at FROM email_send_reservations WHERE created_at>? ORDER BY created_at DESC LIMIT 1 OFFSET ?').get(now - 86400000, policy.dailyLimit - 1).created_at + 86400000);
  if (hourly >= policy.hourlyLimit) limits.push(db.prepare('SELECT created_at FROM email_send_reservations WHERE created_at>? ORDER BY created_at DESC LIMIT 1 OFFSET ?').get(now - 3600000, policy.hourlyLimit - 1).created_at + 3600000);
  return { ...policy, usage: { daily, hourly, remainingToday: Math.max(0, policy.dailyLimit - daily), nextAllowedAt: Math.max(now, ...limits) }, suppressionCount: db.prepare('SELECT count(*) AS n FROM email_suppressions').get().n };
}
export function assertRecipientAllowed(email, now = Date.now()) {
  const to = normalizeEmail(email);
  if (db.prepare('SELECT 1 FROM email_suppressions WHERE email=?').get(to)) throw emailError(409, 'RECIPIENT_SUPPRESSED', 'This address is on your do-not-contact list.');
  const row = db.prepare('SELECT result,checked_at FROM email_verifications WHERE email=?').get(to);
  const recent = row && now - row.checked_at < 30 * 86400000 ? json(row.result) : null;
  if (recent?.status === 'invalid') throw emailError(409, 'RECIPIENT_INVALID', 'The latest verification found an invalid address. Recheck it before sending.');
  if (getEmailPolicy().requireMailboxVerification && !(recent?.status === 'deliverable' && recent?.mode === 'mailbox')) throw emailError(409, 'VERIFICATION_REQUIRED', 'Your sending rules require a recent successful mailbox verification.');
  return to;
}
export function reserveEmailSend({ to, idempotencyKey, text } = {}) {
  return tx(() => {
    to = normalizeEmail(to);
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 200) throw emailError(400, 'INVALID_REQUEST', 'A unique send request is required.');
    const previous = db.prepare('SELECT email FROM email_send_reservations WHERE idempotency_key=?').get(idempotencyKey);
    if (previous) {
      if (previous.email !== to) throw emailError(409, 'DUPLICATE_REQUEST', 'This send request already belongs to another recipient.');
      return getPolicyStatus();
    }
    const status = getPolicyStatus();
    if (status.paused) throw emailError(409, 'SENDING_PAUSED', 'Sending is paused. Resume it in Email settings when ready.');
    assertRecipientAllowed(to);
    if (status.requireOptOut && (typeof text !== 'string' || !text.split(/\r?\n/).some((line) => line.trim() === status.optOutText))) throw emailError(409, 'REVIEW_REQUIRED', 'Review the message again to include your current opt-out line.');
    if (status.usage.nextAllowedAt > Date.now()) throw emailError(429, 'SEND_LIMIT', `Sending limit reached. The next slot opens at ${new Date(status.usage.nextAllowedAt).toLocaleString()}.`);
    db.prepare('INSERT INTO email_send_reservations VALUES(?,?,?)').run(idempotencyKey, to, Date.now());
    return getPolicyStatus();
  });
}
