import crypto from 'node:crypto';
import { db } from './db.js';
import { integrationService } from './integrations.js';
import { smsLength } from '../shared/sms.js';

db.exec(`CREATE TABLE IF NOT EXISTS sms_messages (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, provider TEXT NOT NULL,
 connection_revision TEXT NOT NULL, recipient TEXT NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL,
 status TEXT NOT NULL, provider_id TEXT, error TEXT NOT NULL DEFAULT '', consent_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sms_suppressions (number TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sms_created ON sms_messages(created_at DESC);`);
const fail = (status, message, code = 'SMS_FAILED') => Object.assign(new Error(message), { status, code, smsSafe: true });
const providers = ['twilio', 'telnyx', 'vonage'];
export function normalizeSmsNumber(value) {
  const number = typeof value === 'string' ? value.trim().replace(/[ ()-]/g, '') : '';
  if (!/^\+[1-9]\d{6,14}$/.test(number)) throw fail(400, 'Enter an international number starting with +.');
  return number;
}
const view = row => ({ id: row.id, provider: row.provider, recipient: row.recipient, sender: row.sender, body: row.body, status: row.status, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at });
const twilioAuth = value => ({ Authorization: `Basic ${Buffer.from(`${value.accountSid}:${value.authToken}`).toString('base64')}` });
export function createSmsService({ integrations = integrationService, fetchFn = (...args) => globalThis.fetch(...args), now = Date.now, simulated = false, recoverInterrupted = false } = {}) {
  // A process stopped during submission must not resend that message on restart.
  if (recoverInterrupted) db.prepare("UPDATE sms_messages SET status='unknown',error='Submission was interrupted. Check your provider before sending again.' WHERE status='submitting'").run();
  const row = id => db.prepare('SELECT * FROM sms_messages WHERE id=?').get(id);
  const connections = () => ({ rows: providers.map(id => integrations.status(id)), simulated });
  function list() { return { rows: db.prepare('SELECT * FROM sms_messages ORDER BY created_at DESC LIMIT 100').all().map(view), simulated }; }
  async function providerRequest(url, options) {
    try {
      const response = await fetchFn(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
      let data = null;
      try { data = await response.json(); } catch {}
      return { status: response.status, ok: response.ok, data };
    } catch { return { status: 0, ok: false, data: null }; }
  }
  async function send(input = {}) {
    const { provider, requestId } = input;
    if (!providers.includes(provider)) throw fail(400, 'Choose an SMS provider.');
    if (typeof requestId !== 'string' || !/^[\w-]{16,80}$/.test(requestId)) throw fail(400, 'A message request ID is required.');
    const recipient = normalizeSmsNumber(input.recipient);
    if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 1600 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.body)) throw fail(400, 'Write a message of up to 1,600 characters.');
    const body = input.body.trim();
    if (input.confirmed !== true || input.consent !== true) throw fail(400, 'Confirm the message and recipient SMS permission.');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ provider, recipient, body })).digest('hex');
    const previous = db.prepare('SELECT * FROM sms_messages WHERE request_id=?').get(requestId);
    if (previous) { if (previous.fingerprint !== fingerprint) throw fail(409, 'This request ID belongs to a different message.'); return { message: view(previous), simulated, duplicate: true }; }
    if (!integrations.status(provider).verified) throw fail(409, 'Verify this SMS connection first.');
    if (db.prepare('SELECT 1 FROM sms_suppressions WHERE number=?').get(recipient)) throw fail(409, 'This number is blocked from SMS.');
    if (db.prepare('SELECT count(*) n FROM sms_messages WHERE created_at>?').get(now() - 60000).n >= 10) throw fail(429, 'Wait a minute before sending another message.');
    const value = integrations.credentials(provider), id = crypto.randomUUID(), timestamp = now();
    if (input.connectionRevision !== value.revision) throw fail(409, 'The SMS connection changed. Reload and review the sender again.');
    db.prepare("INSERT INTO sms_messages(id,request_id,fingerprint,provider,connection_revision,recipient,sender,body,status,consent_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'submitting',?,?,?)").run(id, requestId, fingerprint, provider, value.revision, recipient, value.fromNumber, body, timestamp, timestamp, timestamp);
    let result;
    if (provider === 'twilio') result = await providerRequest(`https://api.twilio.com/2010-04-01/Accounts/${value.accountSid}/Messages.json`, { method: 'POST', headers: { ...twilioAuth(value), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ To: recipient, From: value.fromNumber, Body: body }).toString() });
    if (provider === 'telnyx') result = await providerRequest('https://api.telnyx.com/v2/messages', { method: 'POST', headers: { Authorization: `Bearer ${value.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: value.fromNumber, to: recipient, text: body, type: 'SMS' }) });
    if (provider === 'vonage') result = await providerRequest('https://rest.nexmo.com/sms/json', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ api_key: value.apiKey, api_secret: value.apiSecret, from: value.fromNumber.slice(1), to: recipient.slice(1), text: body, type: smsLength(body).unicode ? 'unicode' : 'text' }).toString() });
    const data = result.data;
    let providerId = provider === 'twilio' ? data?.sid : provider === 'telnyx' ? data?.data?.id : data?.messages?.[0]?.['message-id'];
    const validId = typeof providerId === 'string' && /^[\w-]{8,100}$/.test(providerId);
    const vonageAccepted = provider !== 'vonage' || data?.messages?.[0]?.status === '0';
    let status = result.ok && validId && vonageAccepted ? 'accepted' : result.status >= 400 && result.status < 500 || (provider === 'vonage' && typeof data?.messages?.[0]?.status === 'string' && data.messages[0].status !== '0') ? 'failed' : 'unknown';
    if (status === 'accepted' && provider === 'twilio' && ['queued', 'sending', 'sent', 'delivered', 'failed', 'undelivered'].includes(data.status)) status = data.status;
    const error = status === 'unknown' ? 'Delivery is unconfirmed. Check the provider before sending again.' : ['failed', 'undelivered'].includes(status) ? 'The provider rejected this message. Check the sender, destination, and account permissions.' : '';
    db.prepare('UPDATE sms_messages SET status=?,provider_id=?,error=?,updated_at=? WHERE id=?').run(status, validId ? providerId : null, error, now(), id);
    return { message: view(row(id)), simulated };
  }
  async function refresh(id) {
    const saved = row(id);
    if (!saved) throw fail(404, 'Message not found.');
    if (!saved.provider_id || saved.provider === 'vonage') return { message: view(saved), simulated };
    const value = integrations.credentials(saved.provider);
    if (value.revision !== saved.connection_revision) throw fail(409, 'This message belongs to an earlier connection. Check it in your provider account.');
    const result = saved.provider === 'twilio'
      ? await providerRequest(`https://api.twilio.com/2010-04-01/Accounts/${value.accountSid}/Messages/${encodeURIComponent(saved.provider_id)}.json`, { headers: twilioAuth(value) })
      : await providerRequest(`https://api.telnyx.com/v2/messages/${encodeURIComponent(saved.provider_id)}`, { headers: { Authorization: `Bearer ${value.apiKey}` } });
    if (!result.ok) throw fail(502, 'Message status could not be refreshed.');
    const current = saved.provider === 'twilio' ? result.data?.status : result.data?.data?.to?.[0]?.status;
    const status = ({ delivery_failed: 'failed', delivery_unconfirmed: 'unknown' })[current] || current;
    if (['queued', 'sending', 'sent', 'delivered', 'failed', 'undelivered', 'unknown'].includes(status)) db.prepare('UPDATE sms_messages SET status=?,error=?,updated_at=? WHERE id=?').run(status, ['failed', 'undelivered', 'unknown'].includes(status) ? 'Check message details in your provider account.' : '', now(), id);
    return { message: view(row(id)), simulated };
  }
  function suppress(number) { number = normalizeSmsNumber(number); db.prepare('INSERT OR IGNORE INTO sms_suppressions(number,created_at) VALUES(?,?)').run(number, now()); return { number, blocked: true }; }
  return { connections, list, send, refresh, suppress };
}
export const smsService = createSmsService({ recoverInterrupted: true });
