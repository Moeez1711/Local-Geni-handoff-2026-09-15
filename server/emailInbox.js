import crypto from 'node:crypto';
import { db, json, tx } from './db.js';
import { createEmailVault } from './emailVault.js';
import { emailService } from './emailService.js';
import { accountIds, assertAccountId, getAccountRecord, inboxSettings } from './emailAccounts.js';
import { addSuppression, emailError, normalizeEmail } from './emailPolicy.js';
import { recordActivity } from './previewRepo.js';
import { getLead } from './repo.js';

db.exec(`CREATE TABLE IF NOT EXISTS email_inbox_messages (
 id TEXT PRIMARY KEY,account_id TEXT NOT NULL,remote_id TEXT NOT NULL,message_id TEXT,in_reply_to TEXT,
 references_json TEXT NOT NULL DEFAULT '[]',from_email TEXT NOT NULL,from_name TEXT NOT NULL DEFAULT '',
 to_json TEXT NOT NULL DEFAULT '[]',subject TEXT NOT NULL,text TEXT NOT NULL,received_at INTEGER NOT NULL,
 kind TEXT NOT NULL DEFAULT 'unmatched',place_id TEXT,matched_message_id TEXT,UNIQUE(account_id,remote_id));
 CREATE INDEX IF NOT EXISTS idx_email_inbox_received ON email_inbox_messages(account_id,received_at DESC);
`);
const text = (v, max = 10000) => String(v || '').replace(/\0/g, '').slice(0, max);
const normalizeMaybe = (value) => { try { return normalizeEmail(value); } catch { return ''; } };
const validateGraphCursor = (value) => {
  let url; try { url = new URL(value); } catch { throw emailError(502, 'INVALID_GRAPH_CURSOR', 'Microsoft returned an invalid inbox cursor.'); }
  if (url.origin !== 'https://graph.microsoft.com' || !/^\/v1\.0\/me\/mailFolders\/[^/]+\/messages\/delta$/.test(url.pathname) || url.username || url.password || url.hash) throw emailError(502, 'INVALID_GRAPH_CURSOR', 'Microsoft returned an invalid inbox cursor.');
  return value;
};
const tableExists = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
export function stopRecipientSequences(to, reason, accountId = null) {
  if (!tableExists('email_campaign_recipients')) return;
  db.prepare(`UPDATE email_campaign_recipients SET status='stopped',stop_reason=? WHERE lower(to_email)=? AND status IN ('pending','sending')
    ${accountId ? 'AND campaign_id IN (SELECT id FROM email_campaigns WHERE account_id=?)' : ''}`).run(reason, normalizeEmail(to), ...(accountId ? [accountId] : []));
}
function hydrate(row) { return { id: row.id, accountId: row.account_id, remoteId: row.remote_id, messageId: row.message_id, inReplyTo: row.in_reply_to,
  references: json(row.references_json, []), fromEmail: row.from_email, fromName: row.from_name, to: json(row.to_json, []), subject: row.subject,
  text: row.text, receivedAt: row.received_at, kind: row.kind, placeId: row.place_id, matchedMessageId: row.matched_message_id }; }

export function createInboxService({ service = emailService, keyProvider, now = () => Date.now(),
  imapFactory = async (options) => new (await import('imapflow')).ImapFlow(options),
  parser = async (source) => (await import('mailparser')).simpleParser(source, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true }),
} = {}) {
  const vault = createEmailVault({ keyProvider }); const active = new Set();
  const read = (id) => db.prepare('SELECT * FROM email_inbox_settings WHERE account_id=?').get(id);
  function saveSettings(id, body = {}) {
    assertAccountId(id);
    if (active.has(id)) throw emailError(409, 'INBOX_BUSY', 'Wait for the current inbox check to finish.');
    if (typeof body.enabled !== 'boolean') throw emailError(400, 'INVALID_INBOX_SETTINGS', 'Choose whether inbox sync is enabled.');
    const sender = service.forAccount(id).getSettings(); const old = read(id); const oldConfig = json(old?.config_json, {});
    const c = { enabled: body.enabled, provider: sender.provider, host: sender.provider === 'gmail' ? 'imap.gmail.com' : body.host ?? oldConfig.host ?? '', port: 993,
      username: sender.provider === 'gmail' ? sender.fromEmail : body.username ?? oldConfig.username ?? sender.fromEmail, accountRevision: sender.revision };
    if (sender.provider !== 'microsoft') {
      if (body.port !== undefined && Number(body.port) !== 993) throw emailError(400, 'IMAP_TLS_REQUIRED', 'Use IMAP port 993 with TLS.');
      if (typeof c.host !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(c.host) || /\.(local|internal|localhost)$/i.test(c.host) || typeof c.username !== 'string' || /[\r\n\0]/.test(c.username) || c.username.length > 254) throw emailError(400, 'INVALID_IMAP_SETTINGS', 'Enter the public IMAP hostname and username provided by your email service.');
    }
    const same = JSON.stringify(c) === JSON.stringify(oldConfig);
    const sameIdentity = ['provider', 'host', 'port', 'username'].every((field) => c[field] === oldConfig[field]);
    let secret = sameIdentity ? old?.encrypted_secret : null;
    if (body.password) {
      if (typeof body.password !== 'string' || body.password.length > 2048 || body.password.includes('\0')) throw emailError(400, 'INVALID_IMAP_PASSWORD', 'Invalid IMAP password.');
      secret = vault.seal({ password: sender.provider === 'gmail' ? body.password.replace(/\s/g, '') : body.password }, `inbox:${id}:${c.host}:${c.username}`);
    }
    db.prepare(`INSERT INTO email_inbox_settings(account_id,config_json,encrypted_secret,verified_at,cursor_json) VALUES(?,?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET config_json=excluded.config_json,encrypted_secret=excluded.encrypted_secret,verified_at=excluded.verified_at,
      cursor_json=excluded.cursor_json,last_error=NULL`).run(id, JSON.stringify(c), secret, same && !body.password ? old?.verified_at ?? null : null, sameIdentity ? old?.cursor_json ?? null : null);
    return inboxSettings(id);
  }
  async function connection(id) {
    const c = inboxSettings(id); const row = read(id); const sender = service.forAccount(id);
    if (!c.enabled) throw emailError(409, 'INBOX_DISABLED', 'Enable inbox sync before continuing.');
    if (json(row?.config_json, {}).accountRevision !== sender.getSettings().revision) throw emailError(409, 'INBOX_REVERIFY_REQUIRED', 'The sender changed. Save and verify its inbox settings again.');
    const source = await sender.inboxConnection();
    if (source.settings.provider === 'microsoft') return { graph: source };
    const password = row?.encrypted_secret ? vault.open(row.encrypted_secret, `inbox:${id}:${c.host}:${c.username}`).password : source.settings.provider === 'gmail' ? source.password : null;
    if (!password) throw emailError(409, 'IMAP_PASSWORD_REQUIRED', 'Enter an IMAP password. Gmail can reuse its saved app password.');
    const imap = await imapFactory({ host: c.host, port: 993, secure: true, auth: { user: c.username, pass: password },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: c.host }, logger: false, logRaw: false,
      disableAutoIdle: true, disableCompression: true, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
    imap.on?.('error', () => {});
    return { imap };
  }
  async function verify(id) {
    assertAccountId(id); if (active.has(id)) throw emailError(409, 'INBOX_BUSY', 'An inbox check is already running.'); active.add(id);
    let imap;
    try {
      const source = await connection(id); imap = source.imap;
      if (imap) { await imap.connect(); const lock = await imap.getMailboxLock('INBOX', { readOnly: true }); lock.release(); }
      else { const r = await source.graph.fetchFn('https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=id', { headers: { Authorization: `Bearer ${source.graph.accessToken}` } }); if (!r.ok) throw emailError(409, 'MICROSOFT_MAIL_READ_REQUIRED', 'Allow Mail.Read and reconnect Microsoft before syncing your inbox.'); }
      db.prepare('UPDATE email_inbox_settings SET verified_at=?,last_error=NULL WHERE account_id=?').run(now(), id); return inboxSettings(id);
    } catch (e) { db.prepare('UPDATE email_inbox_settings SET verified_at=NULL,last_error=? WHERE account_id=?').run('Inbox connection could not be verified.', id); if (e.status && e.code) throw e; throw emailError(400, 'INBOX_VERIFY_FAILED', 'Inbox verification failed. Check the account permissions, IMAP host, and app password.'); }
    finally { if (imap) { try { await imap.logout(); } catch { imap.close?.(); } } active.delete(id); }
  }
  function applyClassification(row, kind, matched) {
    db.prepare('UPDATE email_inbox_messages SET kind=?,place_id=?,matched_message_id=? WHERE id=?').run(kind, matched?.place_id || null, matched?.id || null, row.id);
    if (!matched || !['reply', 'bounce', 'opt_out'].includes(kind)) return;
    stopRecipientSequences(matched.to_email, kind, kind === 'reply' ? row.account_id : null);
    if (kind !== 'reply') addSuppression({ email: matched.to_email, reason: kind === 'bounce' ? 'bounced' : 'opt_out' });
    if (kind === 'reply' && getLead(matched.place_id)) recordActivity(matched.place_id, { kind: 'reply', channel: 'email', message: row.text, idempotencyKey: `inbox:${row.id}` }, { transaction: false });
  }
  function ingest(accountId, message) {
    const from = normalizeMaybe(message.fromEmail); const receivedAt = Number(message.receivedAt) || now();
    const messageId = text(message.messageId, 998); const refs = [...(message.references || []), message.inReplyTo].filter(Boolean).slice(-20);
    const remoteId = text(message.remoteId || messageId, 1500); if (!remoteId) return null;
    const old = db.prepare('SELECT * FROM email_inbox_messages WHERE account_id=? AND remote_id=?').get(accountId, remoteId); if (old) return hydrate(old);
    const id = crypto.randomUUID();
    const content = text(message.text); const subject = text(message.subject, 500);
    const headers = message.headers || {};
    const deliveryReport = /multipart\/report/i.test(headers['content-type'] || '') || /(?:^|\n)(?:Final-Recipient|Original-Recipient):\s*rfc822;/i.test(content);
    const bouncedTo = deliveryReport ? normalizeMaybe(content.match(/(?:Final-Recipient|Original-Recipient):\s*rfc822;\s*([^\s<>;]+)/i)?.[1]) : '';
    const byReference = refs.length ? db.prepare(`SELECT * FROM email_messages WHERE account_id=? AND status='sent' AND provider_message_id IN (${refs.map(() => '?').join(',')}) ORDER BY accepted_at DESC LIMIT 1`).get(accountId, ...refs) : null;
    const address = bouncedTo || from;
    const matched = byReference || (address ? db.prepare(`SELECT * FROM email_messages WHERE account_id=? AND lower(to_email)=? AND status='sent' AND accepted_at<=? AND accepted_at>? ORDER BY accepted_at DESC LIMIT 1`).get(accountId, address, receivedAt, receivedAt - 90 * 86400000) : null);
    const auto = String(headers['auto-submitted'] || '').toLowerCase();
    const firstReply = content.split(/\n(?:On .+wrote:|From:|>)/)[0].slice(0, 2500);
    const optout = /\b(?:unsubscribe|remove me|remove my|stop (?:emailing|contacting)|no thanks|do not contact|don't contact)\b/i.test(firstReply);
    const trustedSender = matched && (from === normalizeMaybe(matched.to_email) || (deliveryReport && bouncedTo === normalizeMaybe(matched.to_email)));
    const kind = !trustedSender ? 'unmatched' : deliveryReport ? 'bounce' : auto && auto !== 'no' ? 'automated' : optout ? 'opt_out' : 'reply';
    tx(() => {
      db.prepare(`INSERT INTO email_inbox_messages(id,account_id,remote_id,message_id,in_reply_to,references_json,from_email,from_name,to_json,subject,text,received_at,kind)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, accountId, remoteId, messageId || null, text(message.inReplyTo, 998) || null, JSON.stringify(refs), from, text(message.fromName, 200), JSON.stringify(message.to || []), subject, content, receivedAt, kind);
      const row = db.prepare('SELECT * FROM email_inbox_messages WHERE id=?').get(id); applyClassification(row, kind, trustedSender ? matched : null);
    });
    return hydrate(db.prepare('SELECT * FROM email_inbox_messages WHERE id=?').get(id));
  }
  async function sync(id) {
    assertAccountId(id); if (active.has(id)) throw emailError(409, 'INBOX_BUSY', 'An inbox sync is already running.');
    if (!inboxSettings(id).verified) throw emailError(409, 'INBOX_NOT_VERIFIED', 'Verify the inbox connection first.');
    active.add(id); let imap; let count = 0;
    try {
      const source = await connection(id); imap = source.imap; let cursor = json(read(id)?.cursor_json, {});
      if (imap) {
        await imap.connect(); const lock = await imap.getMailboxLock('INBOX', { readOnly: true });
        try {
          const validity = String(imap.mailbox.uidValidity);
          if (cursor.validity !== validity) cursor = { validity, uid: 0 };
          const uids = await imap.search(cursor.uid ? { uid: `${cursor.uid + 1}:*` } : { since: new Date(now() - 30 * 86400000) }, { uid: true });
          const batch = (uids || []).filter((uid) => uid > (cursor.uid || 0)).sort((a, b) => a - b).slice(0, 200);
          for (const uid of batch) {
            const mail = await imap.fetchOne(String(uid), { source: { start: 0, maxLength: 262144 }, uid: true, internalDate: true }, { uid: true });
            if (!mail) { cursor.uid = uid; continue; }
            const parsed = await parser(mail.source);
            const deliveryStatus = (parsed.attachments || []).filter((a) => a.contentType === 'message/delivery-status').map((a) => Buffer.from(a.content).toString('utf8').slice(0, 10000)).join('\n');
            ingest(id, { remoteId: `imap:${validity}:${uid}`, messageId: parsed.messageId, inReplyTo: parsed.inReplyTo, references: Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [],
              fromEmail: parsed.from?.value?.[0]?.address, fromName: parsed.from?.value?.[0]?.name, to: (parsed.to?.value || []).map((a) => a.address), subject: parsed.subject,
              text: `${parsed.text || ''}${deliveryStatus ? `\n${deliveryStatus}` : ''}`, receivedAt: new Date(mail.internalDate || parsed.date || now()).getTime(), headers: Object.fromEntries([...(parsed.headers || new Map())].map(([k, v]) => [k, typeof v === 'string' ? v : v?.value || ''])) });
            cursor.uid = uid; count++;
          }
          cursor.more = batch.length === 200;
        } finally { lock.release(); }
      } else {
        const graph = source.graph;
        let url = cursor.url || `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$select=id,internetMessageId,internetMessageHeaders,from,toRecipients,subject,body,receivedDateTime&$filter=receivedDateTime%20ge%20${new Date(now() - 30 * 86400000).toISOString()}`;
        for (let page = 0; page < 10; page++) {
          validateGraphCursor(url);
          const response = await graph.fetchFn(url, { headers: { Authorization: `Bearer ${graph.accessToken}`, Prefer: 'outlook.body-content-type="text", odata.maxpagesize=100' } });
          if (response.status === 410) { db.prepare('UPDATE email_inbox_settings SET cursor_json=NULL WHERE account_id=?').run(id); throw emailError(409, 'INBOX_CURSOR_EXPIRED', 'Inbox history changed. Sync again to rebuild the last 30 days.'); }
          if (!response.ok) throw emailError(502, 'INBOX_SYNC_FAILED', 'Microsoft inbox sync failed. Check Mail.Read permission and reconnect if needed.');
          const data = await response.json();
          if (!Array.isArray(data.value)) throw emailError(502, 'INBOX_SYNC_FAILED', 'Microsoft did not return a complete inbox response.');
          validateGraphCursor(data['@odata.nextLink'] || data['@odata.deltaLink']);
          for (const m of data.value || []) {
            if (m['@removed']) continue;
            const headers = Object.fromEntries((m.internetMessageHeaders || []).map((h) => [h.name.toLowerCase(), h.value]));
            ingest(id, { remoteId: `graph:${m.id}`, messageId: m.internetMessageId, inReplyTo: headers['in-reply-to'], references: headers.references?.match(/<[^>]+>/g) || [],
              fromEmail: m.from?.emailAddress?.address, fromName: m.from?.emailAddress?.name, to: (m.toRecipients || []).map((r) => r.emailAddress?.address), subject: m.subject,
              text: m.body?.contentType?.toLowerCase() === 'text' ? m.body.content : m.bodyPreview || '', receivedAt: Date.parse(m.receivedDateTime), headers }); count++;
          }
          cursor.url = data['@odata.nextLink'] || data['@odata.deltaLink']; cursor.more = !!data['@odata.nextLink'];
          if (!cursor.url) throw emailError(502, 'INVALID_GRAPH_CURSOR', 'Microsoft did not return an inbox cursor.');
          if (!cursor.more) break; url = cursor.url;
        }
      }
      db.prepare('UPDATE email_inbox_settings SET cursor_json=?,last_sync_at=?,last_error=NULL WHERE account_id=?').run(JSON.stringify(cursor), now(), id);
      return { accountId: id, synced: count, more: !!cursor.more, lastSyncAt: now(), scope: 'Recent inbox mail, beginning with the last 30 days' };
    } catch (e) { db.prepare('UPDATE email_inbox_settings SET last_error=? WHERE account_id=?').run('Inbox sync failed. No scheduled email will send until sync succeeds.', id); if (e.status && e.code) throw e; throw emailError(502, 'INBOX_SYNC_FAILED', 'Inbox sync failed. Check the account connection and try again.'); }
    finally { if (imap) { try { await imap.logout(); } catch { imap.close?.(); } } active.delete(id); }
  }
  function list({ accountId, placeId } = {}) {
    const where = []; const args = [];
    if (accountId) { assertAccountId(accountId); where.push('account_id=?'); args.push(accountId); }
    if (placeId) { where.push('place_id=?'); args.push(placeId); }
    return { rows: db.prepare(`SELECT * FROM email_inbox_messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY received_at DESC LIMIT 200`).all(...args).map(hydrate), accounts: accountIds().map((id) => ({ id, ...inboxSettings(id) })) };
  }
  function classify(id, kind) {
    if (!['reply', 'bounce', 'opt_out', 'ignore'].includes(kind)) throw emailError(400, 'INVALID_INBOX_KIND', 'Choose a valid message type.');
    const row = db.prepare('SELECT * FROM email_inbox_messages WHERE id=?').get(id); if (!row) throw emailError(404, 'INBOX_MESSAGE_NOT_FOUND', 'Inbox message not found.');
    const matched = row.matched_message_id ? db.prepare('SELECT * FROM email_messages WHERE id=?').get(row.matched_message_id) : db.prepare('SELECT * FROM email_messages WHERE account_id=? AND lower(to_email)=? AND status=? ORDER BY accepted_at DESC LIMIT 1').get(row.account_id, row.from_email, 'sent');
    tx(() => applyClassification(row, kind, matched));
    return hydrate(db.prepare('SELECT * FROM email_inbox_messages WHERE id=?').get(id));
  }
  return { saveSettings, verify, sync, list, classify, ingest };
}
export const inboxService = createInboxService();
