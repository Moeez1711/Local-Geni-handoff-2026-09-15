import crypto from 'node:crypto';
import { db, json } from './db.js';
import { emailError } from './emailPolicy.js';

// The original sender remains in its original table. Existing encrypted values and history
// need no destructive migration; named accounts are additive and explicitly created.
db.exec(`CREATE TABLE IF NOT EXISTS email_additional_accounts (
 id TEXT PRIMARY KEY,label TEXT NOT NULL,config_json TEXT NOT NULL DEFAULT '{}',encrypted_secret TEXT,
 revision TEXT NOT NULL,verified_at INTEGER,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS email_account_preferences (id INTEGER PRIMARY KEY CHECK(id=1),current_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS email_inbox_settings (account_id TEXT PRIMARY KEY,config_json TEXT NOT NULL DEFAULT '{}',
 encrypted_secret TEXT,verified_at INTEGER,last_sync_at INTEGER,last_error TEXT,cursor_json TEXT);
`);
export function currentAccountId() { return db.prepare('SELECT current_id FROM email_account_preferences WHERE id=1').get()?.current_id || 'default'; }
export function getAccountRecord(id = 'default') {
  if (id === 'default') { const row = db.prepare('SELECT * FROM email_account WHERE id=1').get(); return row ? { ...row, id: 'default', label: 'Primary sender' } : null; }
  return db.prepare('SELECT * FROM email_additional_accounts WHERE id=?').get(id);
}
export function assertAccountId(id) {
  if (typeof id !== 'string' || (id !== 'default' && !getAccountRecord(id))) throw emailError(404, 'EMAIL_ACCOUNT_NOT_FOUND', 'Sender account not found.');
  return id;
}
export function createAccount({ label = 'Additional sender' } = {}) {
  if (typeof label !== 'string' || !label.trim() || label.length > 100 || /[\r\n\0]/.test(label)) throw emailError(400, 'INVALID_ACCOUNT_LABEL', 'Enter a sender name of 100 characters or fewer.');
  if (db.prepare('SELECT count(*) n FROM email_additional_accounts').get().n >= 20) throw emailError(400, 'ACCOUNT_LIMIT', 'Up to 20 additional senders are supported.');
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO email_additional_accounts(id,label,revision,updated_at) VALUES(?,?,?,?)').run(id, label.trim(), crypto.randomUUID(), Date.now());
  return id;
}
export function selectAccount(id) { assertAccountId(id); db.prepare('INSERT INTO email_account_preferences VALUES(1,?) ON CONFLICT(id) DO UPDATE SET current_id=excluded.current_id').run(id); return id; }
export function accountIds() { return ['default', ...db.prepare('SELECT id FROM email_additional_accounts ORDER BY updated_at DESC').all().map((row) => row.id)]; }
export function persistAccount(id, { configJson, encryptedSecret, revision, verifiedAt, updatedAt }) {
  if (id === 'default') db.prepare(`INSERT INTO email_account(id,config_json,encrypted_secret,revision,verified_at,updated_at) VALUES(1,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,encrypted_secret=excluded.encrypted_secret,revision=excluded.revision,verified_at=excluded.verified_at,updated_at=excluded.updated_at`)
    .run(configJson, encryptedSecret, revision, verifiedAt, updatedAt);
  else { assertAccountId(id); db.prepare('UPDATE email_additional_accounts SET config_json=?,encrypted_secret=?,revision=?,verified_at=?,updated_at=? WHERE id=?').run(configJson, encryptedSecret, revision, verifiedAt, updatedAt, id); }
}
export function updateAccountVerification(id, revision, value) {
  const table = id === 'default' ? 'email_account' : 'email_additional_accounts';
  db.prepare(`UPDATE ${table} SET verified_at=? WHERE id=? AND revision=?`).run(value, id === 'default' ? 1 : id, revision);
}
export function updateAccountSecret(id, revision, secret) {
  const table = id === 'default' ? 'email_account' : 'email_additional_accounts';
  db.prepare(`UPDATE ${table} SET encrypted_secret=? WHERE id=? AND revision=?`).run(secret, id === 'default' ? 1 : id, revision);
}
export function disconnectAccount(id) {
  if (db.prepare("SELECT 1 FROM email_messages WHERE account_id=? AND status='sending' LIMIT 1").get(id)) throw emailError(409, 'EMAIL_BUSY', 'Wait for the current email submission to finish before disconnecting this account.');
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_campaigns'").get()) db.prepare("UPDATE email_campaigns SET status='paused',hold_reason='The sender was disconnected. Reconnect and review before resuming.',updated_at=? WHERE account_id=? AND status='active'").run(Date.now(), id);
  if (id === 'default') db.prepare('DELETE FROM email_account WHERE id=1').run();
  else db.prepare('UPDATE email_additional_accounts SET encrypted_secret=NULL,verified_at=NULL,revision=? WHERE id=?').run(crypto.randomUUID(), id);
  db.prepare('UPDATE email_inbox_settings SET encrypted_secret=NULL,verified_at=NULL,config_json=? WHERE account_id=?').run(JSON.stringify({ enabled: false }), id);
}
export function deleteAccount(id) { assertAccountId(id); disconnectAccount(id); if (id !== 'default') db.prepare('DELETE FROM email_additional_accounts WHERE id=?').run(id); if (currentAccountId() === id) selectAccount('default'); }
export function inboxSettings(id) {
  const row = db.prepare('SELECT * FROM email_inbox_settings WHERE account_id=?').get(id);
  const c = json(row?.config_json, {});
  const sender = getAccountRecord(id);
  return { enabled: false, host: '', port: 993, username: '', ...c, configured: !!row?.encrypted_secret || ((c.provider === 'microsoft' || c.provider === 'gmail') && !!sender?.encrypted_secret), verified: row?.verified_at != null && c.accountRevision === sender?.revision, lastSyncAt: row?.last_sync_at || null, lastError: row?.last_error || null };
}
