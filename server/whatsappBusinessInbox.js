import crypto from 'node:crypto';
import { db, json } from './db.js';
import { getLead } from './repo.js';
import { createWhatsAppInbox } from './whatsappInbox.js';

const fail = (status, code, message) => Object.assign(new Error(message), { status, code, whatsappSafe: true });
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function numberFor(value) {
  const number = String(value || '').replace(/^\+/, '').replace(/[ ()-]/g, '');
  if (!/^[1-9]\d{6,14}$/.test(number)) throw fail(400, 'WHATSAPP_NUMBER_INVALID', 'Choose a valid international WhatsApp number.');
  return number;
}

export function createWhatsAppBusinessInbox({ getAccount, credentials, request, vault, now, recordActivityFn }) {
  // The template outbox already exists when the service constructs this adapter.
  const columns = new Set(db.prepare('PRAGMA table_info(whatsapp_outbox)').all().map(row => row.name));
  for (const [name, type] of Object.entries({ delivery_status: 'TEXT', delivered_at: 'INTEGER', read_at: 'INTEGER', delivery_failed_at: 'INTEGER', delivery_error_code: 'INTEGER' })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE whatsapp_outbox ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_inbox_replies (
    id TEXT PRIMARY KEY, account_key TEXT NOT NULL, account_revision TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, content_hash TEXT NOT NULL, number TEXT NOT NULL,
    place_id TEXT, in_reply_to TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL,
    provider_message_id TEXT, error TEXT, attempted_at INTEGER NOT NULL, accepted_at INTEGER,
    UNIQUE(account_key,idempotency_key)
  ); CREATE INDEX IF NOT EXISTS idx_whatsapp_inbox_replies_thread ON whatsapp_inbox_replies(account_key,number,attempted_at);`);
  db.prepare("UPDATE whatsapp_inbox_replies SET status='unknown',error='The app stopped during submission. Do not resend this reply.' WHERE status='sending'").run();
  const inbox = createWhatsAppInbox({ getAccount, vault, now, recordActivityFn });
  const accountKey = () => { const account = getAccount(); return account.businessAccountId && account.phoneNumberId ? `${account.businessAccountId}:${account.phoneNumberId}` : ''; };
  function getStatus() {
    const account = getAccount();
    return { ...inbox.getStatus(), accountKey: accountKey(), accountRevision: account.revision, configured: account.configured, verified: account.verified, paused: account.paused, webhookPath: '/webhooks/whatsapp', replyType: 'text', history: 'received_webhooks_and_local_sends' };
  }
  function saveConfiguration(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.accountRevision !== getAccount().revision) throw fail(409, 'WHATSAPP_ACCOUNT_CHANGED', 'The business account changed. Refresh before saving webhook settings.');
    inbox.saveConfiguration(body);
    return getStatus();
  }
  function delivery(providerId, number, fallback) {
    if (!providerId) return fallback;
    const events = db.prepare('SELECT status FROM whatsapp_delivery_events WHERE account_key=? AND message_id=? AND number=?').all(accountKey(), providerId, number);
    return ['read', 'delivered', 'failed', 'sent'].find(status => events.some(event => event.status === status)) || fallback;
  }
  function replyView(row) {
    return { id: row.id, number: row.number, direction: 'outbound', type: 'text', text: row.text, receivedAt: row.attempted_at, inReplyTo: row.in_reply_to, status: row.status, deliveryStatus: delivery(row.provider_message_id, row.number, row.status), error: row.error, placeId: row.place_id };
  }
  function outboundMessages(number) {
    const account = getAccount();
    const templates = (number
      ? db.prepare('SELECT * FROM whatsapp_outbox WHERE number=? ORDER BY created_at DESC LIMIT 200').all(number)
      : db.prepare('SELECT * FROM whatsapp_outbox ORDER BY created_at DESC LIMIT 400').all())
      .filter(row => { const snapshot = json(row.snapshot_json, {}); return snapshot.businessAccountId === account.businessAccountId && (snapshot.phoneNumberId ? snapshot.phoneNumberId === account.phoneNumberId : row.account_revision === account.revision); })
      .map(row => { const snapshot = json(row.snapshot_json, {}); return { id: row.id, number: row.number, direction: 'outbound', type: 'template', text: snapshot.text || snapshot.body || '[Template message]', receivedAt: row.created_at, status: row.status, deliveryStatus: delivery(row.provider_message_id, row.number, row.status), error: row.error_message, placeId: row.place_id }; });
    const replies = (number
      ? db.prepare('SELECT * FROM whatsapp_inbox_replies WHERE account_key=? AND number=? ORDER BY attempted_at DESC LIMIT 200').all(accountKey(), number)
      : db.prepare('SELECT * FROM whatsapp_inbox_replies WHERE account_key=? ORDER BY attempted_at DESC LIMIT 400').all(accountKey())).map(replyView);
    return [...templates, ...replies];
  }
  function listThreads() {
    const incoming = inbox.listThreads();
    const threads = new Map(incoming.rows.map(thread => [thread.number, { ...thread, direction: 'inbound' }]));
    for (const message of outboundMessages()) {
      let thread = threads.get(message.number);
      if (!thread) {
        const lead = message.placeId ? getLead(message.placeId) : null;
        thread = { number: message.number, placeId: lead?.place_id || null, businessName: lead?.name || null, lastMessageId: null, ...inbox.replyWindow(message.number) };
      }
      if (!thread.lastMessageAt || message.receivedAt > thread.lastMessageAt) Object.assign(thread, { lastMessageAt: message.receivedAt, lastText: message.text, lastType: message.type, direction: 'outbound', deliveryStatus: message.deliveryStatus });
      threads.set(message.number, thread);
    }
    return { rows: [...threads.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt).slice(0, 200), ...getStatus() };
  }
  function listMessages({ number } = {}) {
    number = numberFor(number);
    const incoming = inbox.listMessages({ number });
    const thread = inbox.listThreads().rows.find(row => row.number === number);
    const account = getAccount();
    return { ...incoming, rows: [...incoming.rows, ...outboundMessages(number)].sort((a, b) => a.receivedAt - b.receivedAt).slice(-200), canReply: Boolean(thread?.canReply && account.verified && !account.paused), inReplyTo: thread?.lastMessageId || null, accountKey: accountKey(), accountRevision: account.revision };
  }
  async function sendReply(body = {}) {
    const number = numberFor(body?.number);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || !/^[a-zA-Z0-9_-]{8,128}$/.test(body.idempotencyKey || '')) throw fail(400, 'WHATSAPP_REPLY_INVALID', 'Enter a text reply of up to 4096 characters.');
    const connection = credentials();
    const key = accountKey();
    if (body.accountRevision !== connection.row.revision) throw fail(409, 'WHATSAPP_ACCOUNT_CHANGED', 'The WhatsApp account changed. Refresh the conversation before sending.');
    const contentHash = hash([key, number, body.inReplyTo, text]);
    const previous = db.prepare('SELECT * FROM whatsapp_inbox_replies WHERE account_key=? AND idempotency_key=?').get(key, body.idempotencyKey);
    if (previous) {
      if (previous.content_hash !== contentHash) throw fail(409, 'WHATSAPP_REPLY_KEY_REUSED', 'This submission key belongs to a different reply. Refresh the conversation.');
      return { message: replyView(previous), duplicate: true };
    }
    // A new browser tab must not accidentally resend an uncertain submission.
    const duplicate = db.prepare("SELECT * FROM whatsapp_inbox_replies WHERE account_key=? AND content_hash=? AND status IN ('sending','accepted','unknown') ORDER BY attempted_at DESC LIMIT 1").get(key, contentHash);
    if (duplicate) return { message: replyView(duplicate), duplicate: true };
    if (connection.config.paused) throw fail(409, 'WHATSAPP_PAUSED', 'Business API sending is paused.');
    inbox.assertReplyAllowed({ number, inReplyTo: body.inReplyTo });
    const conversation = listMessages({ number });
    if (!conversation.canReply) throw fail(409, 'WHATSAPP_REPLY_NOT_ALLOWED', 'This conversation is not available for a text reply. Check the connection, opt-out status and reply window.');
    const last = db.prepare('SELECT MAX(attempted_at) time FROM whatsapp_inbox_replies WHERE account_key=?').get(key)?.time;
    if (last && now() - last < 1000) throw fail(429, 'WHATSAPP_REPLY_PACE', 'Wait a moment before sending another reply.');
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO whatsapp_inbox_replies(id,account_key,account_revision,idempotency_key,content_hash,number,place_id,in_reply_to,text,status,attempted_at) VALUES(?,?,?,?,?,?,?,?,?,'sending',?)").run(id, key, connection.row.revision, body.idempotencyKey, contentHash, number, conversation.placeId || null, body.inReplyTo, text, now());
    try {
      const response = await request(connection, `${connection.config.phoneNumberId}/messages`, { body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: number, context: { message_id: body.inReplyTo }, type: 'text', text: { preview_url: false, body: text } } });
      const providerId = response?.messages?.[0]?.id;
      if (typeof providerId !== 'string' || !/^wamid\.[A-Za-z0-9_+/=.-]{1,1000}$/.test(providerId)) throw fail(502, 'WHATSAPP_SUBMISSION_UNKNOWN', 'Meta did not return a valid message receipt. Do not resend this reply.');
      db.prepare("UPDATE whatsapp_inbox_replies SET status='accepted',provider_message_id=?,accepted_at=? WHERE id=?").run(providerId, now(), id);
    } catch (error) {
      const rejected = error.code === 'WHATSAPP_PROVIDER_REJECTED';
      db.prepare('UPDATE whatsapp_inbox_replies SET status=?,error=? WHERE id=?').run(rejected ? 'failed' : 'unknown', rejected ? 'Meta rejected this reply. Check your business account and recipient.' : 'The send result is unknown. Do not resend this reply; check the provider before sending it again.', id);
    }
    const row = db.prepare('SELECT * FROM whatsapp_inbox_replies WHERE id=?').get(id);
    if (row.status === 'accepted' && row.place_id) {
      try { recordActivityFn(row.place_id, { kind: 'sent', channel: 'whatsapp', message: text, idempotencyKey: `wa-reply:${id}` }); }
      catch { /* Provider acceptance must not be misreported as failure if CRM logging fails. */ }
    }
    return { message: replyView(row), duplicate: false };
  }
  return { getStatus, saveConfiguration, listThreads, listMessages, sendReply, clearWebhookConfiguration: inbox.clearConfiguration, verifyWebhookChallenge: inbox.verifyWebhookChallenge, ingestVerifiedWebhook: inbox.ingestVerifiedWebhook };
}
