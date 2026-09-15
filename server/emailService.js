/** Explicitly reviewed single-recipient email. No background sends or automatic send retries. */
import crypto from 'node:crypto';
import { db, json, tx } from './db.js';
import { getLead } from './repo.js';
import { recordActivity } from './previewRepo.js';
import { createEmailVault } from './emailVault.js';
import * as defaultPolicy from './emailPolicy.js';
import { getAccountRecord, persistAccount, updateAccountVerification, updateAccountSecret, disconnectAccount, assertAccountId, inboxSettings } from './emailAccounts.js';

// Provider contracts: https://nodemailer.com/smtp
// https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code
// https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0
const SCOPES = 'https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Send offline_access';
const INBOX_SCOPES = `${SCOPES} https://graph.microsoft.com/Mail.Read`;
let publicUnsubscribeLink = () => null;
export function setEmailUnsubscribeProvider(provider) { publicUnsubscribeLink = provider; }
let publicOptOutSync = async () => {};
export function setEmailPublicSync(sync) { publicOptOutSync = sync; }
const GRAPH = 'https://graph.microsoft.com/v1.0';
const REVIEW_MS = 15 * 60 * 1000;
const error = (status, code, message) => Object.assign(new Error(message), { status, code, emailSafe: true });
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value) => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw error(400, 'INVALID_INPUT', 'Provide an email settings object.'); return value; };
const bounded = (value, label, max, { optional = false, header = false } = {}) => {
  if (optional && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim()) || /\0/.test(value) || (header && /[\r\n\u0001-\u001f\u007f]/.test(value))) throw error(400, 'INVALID_INPUT', `${label} is invalid or too long.`);
  return value;
};
export function validateEmailAddress(value, label = 'Email address', optional = false) {
  const address = bounded(value, label, 254, { optional, header: true }).trim();
  if (optional && !address) return '';
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(address) || address.split('@')[0].length > 64) throw error(400, 'INVALID_EMAIL', `${label} must contain one valid email address.`);
  return address;
}
const clientId = (value) => { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw error(400, 'INVALID_CLIENT_ID', 'Enter your Microsoft application client ID.'); return value.toLowerCase(); };
const tenantId = (value = 'common') => { if (!['common', 'organizations', 'consumers'].includes(value) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw error(400, 'INVALID_TENANT', 'Choose a Microsoft account type or a valid tenant ID.'); return value; };
const accountIdentity = (c) => hash([c.provider, c.fromEmail?.toLowerCase(), c.host, c.port, c.username, c.clientId, c.tenant]);
const configDefaults = { provider: 'gmail', fromName: '', fromEmail: '', replyTo: '', host: 'smtp.gmail.com', port: 465, username: '', clientId: '', tenant: 'common', connectedEmail: '' };

db.exec(`
CREATE TABLE IF NOT EXISTS email_account (
  id INTEGER PRIMARY KEY CHECK(id=1), config_json TEXT NOT NULL, encrypted_secret TEXT,
  revision TEXT NOT NULL, verified_at INTEGER, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_messages (
  id TEXT PRIMARY KEY, place_id TEXT NOT NULL, to_email TEXT NOT NULL, subject TEXT NOT NULL,
  text TEXT NOT NULL, provider TEXT NOT NULL, from_email TEXT NOT NULL, from_name TEXT NOT NULL,
  reply_to TEXT NOT NULL, account_revision TEXT NOT NULL, idempotency_key TEXT UNIQUE NOT NULL,
  payload_hash TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  accepted_at INTEGER, provider_message_id TEXT, error_code TEXT, error_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_messages_lead ON email_messages(place_id,created_at DESC);
`);
if (!db.prepare('PRAGMA table_info(email_messages)').all().some((column) => column.name === 'review_hash')) db.exec('ALTER TABLE email_messages ADD COLUMN review_hash TEXT');
for (const [column, sql] of [['account_id', "TEXT NOT NULL DEFAULT 'default'"], ['in_reply_to', 'TEXT'], ['references_json', "TEXT NOT NULL DEFAULT '[]'"]]) {
  if (!db.prepare('PRAGMA table_info(email_messages)').all().some((item) => item.name === column)) db.exec(`ALTER TABLE email_messages ADD COLUMN ${column} ${sql}`);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_email_messages_review ON email_messages(review_hash)');

export function createEmailService({
  transportFactory = async (options) => (await import('nodemailer')).default.createTransport(options),
  fetchFn = (...args) => fetch(...args), now = () => Date.now(), keyProvider,
  policyHooks = defaultPolicy, recordActivityFn = recordActivity,
  accountId = 'default', recoverOnStart = true,
  unsubscribeLink = (input) => publicUnsubscribeLink(input),
  syncPublicOptOuts = () => publicOptOutSync(),
  getDkimConfig = async (fromEmail) => {
    const infrastructure = await import('./emailInfrastructure.js');
    return infrastructure.getDkimSigningConfig(fromEmail);
  },
} = {}) {
  const vault = createEmailVault({ keyProvider });
  const reviewKey = crypto.randomBytes(32);
  const active = new Set();
  let pending = null;
  let polling = false;
  // A process restart can never establish whether a provider accepted a pending request.
  if (recoverOnStart) db.prepare(`UPDATE email_messages SET status='unknown',error_code='PROCESS_INTERRUPTED',
    error_text='The app restarted before the provider result was recorded. Check Sent mail before considering another message.',updated_at=? WHERE status='sending'`).run(now());
  const accountRow = () => getAccountRecord(accountId);
  const configFor = (row = accountRow()) => ({ ...configDefaults, ...json(row?.config_json, {}) });
  const secretContext = (c) => `sender:${accountId === 'default' ? '' : `${accountId}:`}${accountIdentity(c)}`;
  const secretFor = (row) => vault.open(row.encrypted_secret, secretContext(configFor(row)));
  const assertIdle = () => { if (active.size) throw error(409, 'EMAIL_BUSY', 'Wait for the current email operation to finish.'); };
  function getSettings() {
    const row = accountRow(); const c = configFor(row);
    return { ...c, id: accountId, accountId, label: row?.label || 'Primary sender', inbox: inboxSettings(accountId), configured: !!row?.encrypted_secret, verified: row?.verified_at != null, hasSecret: !!row?.encrypted_secret, verifiedAt: row?.verified_at ?? null, revision: row?.revision || null };
  }
  function persist(c, secret, verifiedAt = null, revision = crypto.randomUUID()) {
    const encrypted = secret ? vault.seal(secret, secretContext(c)) : null;
    persistAccount(accountId, { configJson: JSON.stringify(c), encryptedSecret: encrypted, revision, verifiedAt, updatedAt: now() });
  }
  function saveSettings(body) {
    assertIdle(); object(body);
    const old = accountRow(); const previous = configFor(old);
    const c = { ...previous };
    c.provider = body.provider ?? c.provider;
    if (!['gmail', 'smtp', 'microsoft'].includes(c.provider)) throw error(400, 'INVALID_PROVIDER', 'Choose Gmail, Microsoft, or SMTP.');
    for (const field of ['fromName', 'replyTo']) if (body[field] !== undefined) c[field] = field === 'replyTo' ? validateEmailAddress(body[field], 'Reply-to address', true) : bounded(body[field], 'Sender name', 120, { optional: true, header: true });
    c.fromEmail = body.fromEmail !== undefined ? validateEmailAddress(body.fromEmail, 'Sender address', c.provider === 'microsoft') : c.fromEmail;
    if (c.provider === 'microsoft') {
      c.clientId = clientId(body.clientId ?? c.clientId); c.tenant = tenantId(body.tenant ?? c.tenant);
      c.host = ''; c.port = null; c.username = '';
    } else {
      c.fromEmail = validateEmailAddress(c.fromEmail, 'Sender address');
      c.clientId = ''; c.tenant = 'common';
      if (c.provider === 'gmail') { c.host = 'smtp.gmail.com'; c.port = 465; c.username = c.fromEmail; }
      else {
        c.host = bounded(body.host ?? c.host, 'SMTP hostname', 253, { header: true }).trim().toLowerCase();
        if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(c.host) || /\.(?:local|localhost|internal)$/.test(c.host)) throw error(400, 'INVALID_SMTP_HOST', 'Enter the public hostname supplied by your email provider.');
        c.port = Number(body.port ?? c.port);
        if (![465, 587].includes(c.port)) throw error(400, 'INVALID_SMTP_PORT', 'Use port 465 for TLS or 587 for STARTTLS.');
        c.username = bounded(body.username ?? c.username, 'SMTP username', 254, { header: true });
      }
    }
    const sameIdentity = old && accountIdentity(c) === accountIdentity(previous);
    let secret = sameIdentity && old.encrypted_secret ? secretFor(old) : null;
    const suppliedPassword = body.password !== undefined && body.password !== '';
    if (suppliedPassword) {
      if (c.provider === 'microsoft') throw error(400, 'MICROSOFT_OAUTH_REQUIRED', 'Use Microsoft sign-in for this account.');
      let password = bounded(body.password, 'Password', 2048);
      if (c.provider === 'gmail') password = password.replace(/\s/g, '');
      if (!password) throw error(400, 'PASSWORD_REQUIRED', 'Enter an app password.');
      secret = { password };
    }
    if (!sameIdentity) c.connectedEmail = '';
    if (c.provider === 'microsoft' && sameIdentity && previous.connectedEmail && c.fromEmail.toLowerCase() !== previous.connectedEmail.toLowerCase()) throw error(400, 'SENDER_MISMATCH', 'Microsoft sends from the account you connected.');
    const unchanged = old && JSON.stringify(c) === JSON.stringify(previous) && !suppliedPassword;
    persist(c, secret, unchanged ? old.verified_at : null, unchanged ? old.revision : crypto.randomUUID());
    pending = null;
    return getSettings();
  }
  function assertConfigured() {
    const row = accountRow();
    if (!row?.encrypted_secret) throw error(409, 'EMAIL_NOT_CONFIGURED', 'Connect a sender account first.');
    return row;
  }
  function assertVerified() {
    const row = assertConfigured();
    if (row.verified_at == null) throw error(409, 'EMAIL_NOT_VERIFIED', 'Verify the sender connection before reviewing an email.');
    return row;
  }
  function invalidate(row) { updateAccountVerification(accountId, row.revision, null); }
  function assertSameAccount(row) { if (accountRow()?.revision !== row.revision) throw error(409, 'EMAIL_ACCOUNT_CHANGED', 'The sender changed. Review the current account before continuing.'); }
  async function smtp(row) {
    const c = configFor(row); const secret = secretFor(row);
    if (!secret?.password) throw error(409, 'EMAIL_NOT_CONFIGURED', 'Reconnect your email account.');
    const signing = c.provider === 'smtp' ? await getDkimConfig(c.fromEmail) : null;
    return transportFactory({ host: c.host, port: c.port, secure: c.port === 465, requireTLS: c.port === 587,
      ignoreTLS: false, opportunisticTLS: false, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: c.host },
      auth: { user: c.username, pass: secret.password }, pool: false, logger: false, debug: false,
      disableFileAccess: true, disableUrlAccess: true, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000, dnsTimeout: 10000,
      ...(signing ? { dkim: { ...signing, headerFieldNames: 'From:Sender:Reply-To:Subject:Date:Message-ID:To:Cc:MIME-Version:Content-Type:Content-Transfer-Encoding:Content-ID:Content-Description:In-Reply-To:References:List-Id:List-Help:List-Unsubscribe:List-Unsubscribe-Post:List-Subscribe:List-Post:List-Owner:List-Archive' } } : {}),
    });
  }
  async function microsoftRequest(url, options = {}) {
    // URLs are constructed only from fixed Microsoft origins; credentials never follow redirects.
    return fetchFn(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
  }
  async function responseJson(response) { try { return await response.json(); } catch { throw error(502, 'EMAIL_PROVIDER_RESPONSE', 'The email provider returned an unexpected response.'); } }
  async function tokenRequest(c, fields) {
    return microsoftRequest(`https://login.microsoftonline.com/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.clientId, ...fields }).toString(),
    });
  }
  function tokensFrom(data, previous = {}) {
    if (!data || typeof data.access_token !== 'string' || data.access_token.length > 64000 || (data.token_type && data.token_type.toLowerCase() !== 'bearer')) throw error(502, 'MICROSOFT_AUTH_RESPONSE', 'Microsoft did not return a usable connection.');
    const scopes = String(data.scope || '').toLowerCase().split(/\s+/).map((s) => s.split('/').pop());
    if (!scopes.includes('mail.send') || !scopes.includes('user.read')) throw error(403, 'MICROSOFT_SCOPE_REQUIRED', 'Allow the requested Mail.Send and User.Read permissions to connect.');
    const refreshToken = data.refresh_token || previous.refreshToken;
    if (typeof refreshToken !== 'string' || refreshToken.length > 64000) throw error(403, 'MICROSOFT_REFRESH_REQUIRED', 'Reconnect Microsoft and allow offline access.');
    const expiresIn = Number(data.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw error(502, 'MICROSOFT_AUTH_RESPONSE', 'Microsoft did not return a usable connection.');
    return { accessToken: data.access_token, refreshToken, scopes, expiresAt: now() + Math.min(expiresIn, 86400) * 1000 };
  }
  async function profile(accessToken) {
    const response = await microsoftRequest(`${GRAPH}/me?$select=id,mail,userPrincipalName,displayName`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw error(403, 'MICROSOFT_PROFILE_FAILED', 'Microsoft could not confirm this account. Reconnect and allow the requested permissions.');
    const data = await responseJson(response);
    return { email: validateEmailAddress(data.mail || data.userPrincipalName, 'Connected Microsoft address'), name: typeof data.displayName === 'string' ? data.displayName.replace(/[\r\n\u0000-\u001f\u007f]/g, '').slice(0, 120) : '' };
  }
  async function accessToken(row) {
    const secret = secretFor(row); const c = configFor(row);
    if (!secret?.refreshToken) throw error(409, 'MICROSOFT_RECONNECT', 'Reconnect the Microsoft account.');
    if (secret.accessToken && secret.expiresAt > now() + 60000) return secret.accessToken;
    let response;
    try { response = await tokenRequest(c, { grant_type: 'refresh_token', refresh_token: secret.refreshToken, scope: secret.scopes?.includes('mail.read') ? INBOX_SCOPES : SCOPES }); }
    catch { throw error(502, 'MICROSOFT_REFRESH_FAILED', 'Microsoft could not refresh the connection. No email was submitted.'); }
    if (!response.ok) { invalidate(row); throw error(409, 'MICROSOFT_RECONNECT', 'Reconnect the Microsoft account before sending.'); }
    const tokens = tokensFrom(await responseJson(response), secret);
    assertSameAccount(row);
    updateAccountSecret(accountId, row.revision, vault.seal(tokens, secretContext(c)));
    return tokens.accessToken;
  }
  async function verify() {
    const row = assertConfigured(); const operation = crypto.randomUUID(); active.add(operation);
    let transport;
    try {
      const c = configFor(row);
      if (c.provider === 'microsoft') {
        const me = await profile(await accessToken(row));
        if (me.email.toLowerCase() !== c.fromEmail.toLowerCase()) throw error(409, 'SENDER_MISMATCH', 'Reconnect the Microsoft account to confirm the sender address.');
      } else { transport = await smtp(row); await transport.verify(); }
      assertSameAccount(row);
      updateAccountVerification(accountId, row.revision, now());
      return getSettings();
    } catch (e) {
      invalidate(row);
      if (e.emailSafe) throw e;
      throw error(400, 'EMAIL_VERIFY_FAILED', 'The connection could not be verified. Check the provider, username, app password, and TLS port.');
    } finally { active.delete(operation); transport?.close?.(); }
  }
  async function startMicrosoft(body) {
    assertIdle(); object(body);
    const c = { clientId: clientId(body.clientId), tenant: tenantId(body.tenant), inbox: body.inbox === true };
    const marker = {}; pending = marker;
    let response;
    try {
      response = await microsoftRequest(`https://login.microsoftonline.com/${encodeURIComponent(c.tenant)}/oauth2/v2.0/devicecode`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.clientId, scope: c.inbox ? INBOX_SCOPES : SCOPES }).toString(),
      });
      if (!response.ok) throw error(400, 'MICROSOFT_START_FAILED', 'Microsoft sign-in could not start. Check the client ID, supported account type, and public client flow setting.');
      const data = await responseJson(response); const uri = new URL(data.verification_uri);
      if (uri.protocol !== 'https:' || !['microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com'].includes(uri.hostname) || uri.username || uri.password || typeof data.device_code !== 'string' || data.device_code.length > 64000 || typeof data.user_code !== 'string' || data.user_code.length > 50) throw error(502, 'MICROSOFT_AUTH_RESPONSE', 'Microsoft did not return a usable sign-in code.');
      const expires = Number(data.expires_in); const interval = Math.max(5, Math.min(Number(data.interval) || 5, 60));
      if (!Number.isFinite(expires) || expires <= 0) throw error(502, 'MICROSOFT_AUTH_RESPONSE', 'Microsoft did not return a usable sign-in code.');
      if (pending !== marker) throw error(409, 'MICROSOFT_FLOW_CANCELLED', 'This sign-in was cancelled.');
      pending = { ...c, deviceCode: data.device_code, expiresAt: now() + Math.min(expires, 1800) * 1000, interval, nextPollAt: now() + interval * 1000, baseRevision: accountRow()?.revision || null };
      return { verificationUri: uri.href, userCode: data.user_code, expiresAt: pending.expiresAt, interval };
    } catch (e) { if (pending === marker) pending = null; if (e.emailSafe) throw e; throw error(502, 'MICROSOFT_START_FAILED', 'Microsoft sign-in could not be started. Try again.'); }
  }
  async function pollMicrosoft() {
    const flow = pending;
    if (!flow?.deviceCode || flow.expiresAt <= now()) { pending = null; return { status: 'expired' }; }
    if (polling || now() < flow.nextPollAt) return { status: 'pending', interval: flow.interval };
    polling = true; flow.nextPollAt = now() + flow.interval * 1000;
    try {
      const response = await tokenRequest(flow, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: flow.deviceCode });
      const data = await responseJson(response);
      if (pending !== flow) return { status: 'expired' };
      if (!response.ok) {
        if (data.error === 'authorization_pending') return { status: 'pending', interval: flow.interval };
        if (data.error === 'slow_down') { flow.interval += 5; flow.nextPollAt = now() + flow.interval * 1000; return { status: 'pending', interval: flow.interval }; }
        pending = null;
        if (['expired_token', 'authorization_declined', 'access_denied', 'bad_verification_code'].includes(data.error)) return { status: 'expired' };
        throw error(400, 'MICROSOFT_CONNECT_FAILED', 'Microsoft sign-in was not completed. Check the app registration and try again.');
      }
      const tokens = tokensFrom(data);
      if (flow.inbox && !tokens.scopes.includes('mail.read')) throw error(403, 'MICROSOFT_MAIL_READ_REQUIRED', 'Reconnect Microsoft and allow Mail.Read for inbox sync.');
      const me = await profile(tokens.accessToken);
      if (pending !== flow || (accountRow()?.revision || null) !== flow.baseRevision) return { status: 'expired' };
      assertIdle();
      const previous = configFor();
      const c = { ...configDefaults, provider: 'microsoft', fromEmail: me.email, connectedEmail: me.email, fromName: previous.fromName || me.name,
        replyTo: previous.replyTo, clientId: flow.clientId, tenant: flow.tenant, host: '', port: null, username: '' };
      persist(c, tokens, now()); pending = null;
      return { status: 'connected', settings: getSettings() };
    } catch (e) { if (e.emailSafe) throw e; throw error(502, 'MICROSOFT_POLL_FAILED', 'Microsoft could not finish checking this sign-in. No email was sent.'); }
    finally { polling = false; }
  }
  function cancelMicrosoft() { pending = null; return { ok: true }; }
  function disconnect() { assertIdle(); pending = null; disconnectAccount(accountId); return getSettings(); }
  function messageFor(row) { return row ? { id: row.id, placeId: row.place_id, to: row.to_email, subject: row.subject, text: row.text,
    provider: row.provider, fromEmail: row.from_email, fromName: row.from_name, replyTo: row.reply_to, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at, acceptedAt: row.accepted_at, providerMessageId: row.provider_message_id,
    errorCode: row.error_code, error: row.error_text, accountId: row.account_id, inReplyTo: row.in_reply_to, references: json(row.references_json, []) } : null; }
  const readMessage = (id) => messageFor(db.prepare('SELECT * FROM email_messages WHERE id=?').get(id));
  function listMessages({ placeId } = {}) {
    if (placeId !== undefined && typeof placeId !== 'string') throw error(400, 'INVALID_INPUT', 'Choose a business.');
    return { rows: db.prepare(`SELECT * FROM email_messages WHERE account_id=? ${placeId ? 'AND place_id=?' : ''} ORDER BY created_at DESC,id DESC LIMIT 200`).all(accountId, ...(placeId ? [placeId] : [])).map(messageFor) };
  }
  function payload(body) {
    object(body);
    const placeId = bounded(body.placeId, 'Business ID', 1000, { header: true });
    if (!getLead(placeId)) throw error(404, 'BUSINESS_NOT_FOUND', 'Business not found.');
    const p = { placeId, to: validateEmailAddress(body.to, 'Recipient'), subject: bounded(body.subject, 'Subject', 200, { header: true }), text: bounded(body.text, 'Message', 10000) };
    if (accountId !== 'default') p.accountId = accountId;
    if (body.inReplyTo) {
      p.inReplyTo = bounded(body.inReplyTo, 'Reply reference', 998, { header: true });
      if (!/^<[^<>\s]+>$/.test(p.inReplyTo)) throw error(400, 'INVALID_REPLY_REFERENCE', 'Choose a valid message to reply to.');
    }
    if (body.references?.length) {
      if (!Array.isArray(body.references) || body.references.length > 20 || body.references.some((v) => typeof v !== 'string' || v.length > 998 || !/^<[^<>\s\u0000-\u001f\u007f]+>$/.test(v))) throw error(400, 'INVALID_REPLY_REFERENCE', 'Invalid reply references.');
      p.references = body.references;
    }
    if (body.unsubscribeUrl) {
      let url; try { url = new URL(body.unsubscribeUrl); } catch { throw error(400, 'INVALID_UNSUBSCRIBE_URL', 'Invalid unsubscribe link.'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048) throw error(400, 'INVALID_UNSUBSCRIBE_URL', 'Invalid unsubscribe link.');
      p.unsubscribeUrl = url.href;
    }
    return p;
  }
  function policyRevision() { const policy = policyHooks.getEmailPolicy(); return policy.revision ?? hash(policy); }
  function reviewBinding(p, row) { return hash({ ...p, accountRevision: row.revision, policyRevision: policyRevision() }); }
  function signReview(binding, expiresAt) { const data = Buffer.from(JSON.stringify({ binding, expiresAt, nonce: crypto.randomUUID() })).toString('base64url'); return `${data}.${crypto.createHmac('sha256', reviewKey).update(data).digest('base64url')}`; }
  function checkReview(token, p, row) {
    try {
      if (typeof token !== 'string' || token.length > 1000) throw new Error();
      const [data, signature, extra] = token.split('.');
      const expected = crypto.createHmac('sha256', reviewKey).update(data).digest(); const provided = Buffer.from(signature || '', 'base64url');
      if (extra || provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) throw new Error();
      const decoded = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
      if (decoded.expiresAt <= now() || decoded.binding !== reviewBinding(p, row)) throw new Error();
    } catch { throw error(409, 'EMAIL_REVIEW_REQUIRED', 'Review the current message and sender again before sending.'); }
  }
  function prepare(body) {
    const row = assertVerified(); const c = configFor(row); const p = payload(body);
    policyHooks.assertRecipientAllowed?.(p.to);
    p.text = bounded(policyHooks.prepareEmailText(p.text), 'Message including email footer', 10000);
    const link = unsubscribeLink({ accountId, to: p.to });
    if (link) { p.unsubscribeUrl = link; if (!p.text.includes(link)) p.text = bounded(`${p.text}\nUnsubscribe: ${link}`, 'Message including unsubscribe link', 10000); }
    const expiresAt = now() + REVIEW_MS;
    return { ...p, fromName: c.fromName, fromEmail: c.fromEmail, replyTo: c.replyTo, provider: c.provider, reviewToken: signReview(reviewBinding(p, row), expiresAt), expiresAt };
  }
  function finish(id, status, { errorCode = null, errorText = null, providerMessageId = null } = {}) {
    db.prepare('UPDATE email_messages SET status=?,updated_at=?,accepted_at=?,provider_message_id=?,error_code=?,error_text=? WHERE id=?')
      .run(status, now(), status === 'sent' ? now() : null, providerMessageId, errorCode, errorText, id);
  }
  async function sendEmail(body, { beforeSubmit = () => {} } = {}) {
    const p = payload(body);
    const key = bounded(body.idempotencyKey, 'Message reference', 150, { header: true });
    if (!/^[A-Za-z0-9_.:-]{8,150}$/.test(key)) throw error(400, 'INVALID_IDEMPOTENCY_KEY', 'Use a unique message reference.');
    const payloadHash = hash(p);
    const existing = db.prepare('SELECT * FROM email_messages WHERE idempotency_key=?').get(key);
    if (existing) {
      if (existing.account_id !== accountId || existing.payload_hash !== payloadHash) throw error(409, 'IDEMPOTENCY_CONFLICT', 'This message reference was already used for different content or another sender.');
      return { message: messageFor(existing) };
    }
    // A consumed review cannot be submitted again under a different request key.
    const reviewHash = typeof body.reviewToken === 'string' && body.reviewToken.length <= 1000 ? hash(body.reviewToken) : null;
    const reviewedAttempt = reviewHash && db.prepare('SELECT * FROM email_messages WHERE review_hash=?').get(reviewHash);
    if (reviewedAttempt) {
      if (reviewedAttempt.account_id !== accountId || reviewedAttempt.payload_hash !== payloadHash) throw error(409, 'EMAIL_REVIEW_REQUIRED', 'Review the changed message before sending.');
      return { message: messageFor(reviewedAttempt) };
    }
    if (body.confirmed !== true) throw error(400, 'EMAIL_CONFIRMATION_REQUIRED', 'Review the email and confirm sending.');
    const row = assertVerified(); const c = configFor(row);
    if (body.expectedFromEmail !== undefined && validateEmailAddress(body.expectedFromEmail, 'Expected sender').toLowerCase() !== c.fromEmail.toLowerCase()) throw error(409, 'EMAIL_ACCOUNT_CHANGED', 'The sender changed. Review the message again.');
    checkReview(body.reviewToken, p, row);
    const id = crypto.randomUUID(); const createdAt = now();
    db.prepare(`INSERT INTO email_messages(id,place_id,to_email,subject,text,provider,from_email,from_name,reply_to,account_revision,idempotency_key,payload_hash,status,created_at,updated_at,review_hash,account_id,in_reply_to,references_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'sending',?,?,?,?,?,?)`).run(id, p.placeId, p.to, p.subject, p.text, c.provider, c.fromEmail, c.fromName, c.replyTo, row.revision, key, payloadHash, createdAt, createdAt, reviewHash, accountId, p.inReplyTo || null, JSON.stringify(p.references || []));
    active.add(id);
    let transport; let submitted = false;
    try {
      // Reserve only after the durable idempotency lock. The policy never edits reviewed text.
      await syncPublicOptOuts();
      policyHooks.reserveEmailSend({ to: p.to, idempotencyKey: key, text: p.text, accountId });
      let providerMessageId = null;
      if (c.provider === 'microsoft') {
        const token = await accessToken(row);
        let mime = null;
        if (p.inReplyTo || p.references?.length || p.unsubscribeUrl) {
          const nodemailer = (await import('nodemailer')).default;
          const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows', disableFileAccess: true, disableUrlAccess: true });
          const built = await composer.sendMail({ from: { name: c.fromName, address: c.fromEmail }, to: [{ address: p.to }], subject: p.subject, text: p.text,
            ...(c.replyTo ? { replyTo: c.replyTo } : {}), ...(p.inReplyTo ? { inReplyTo: p.inReplyTo } : {}), ...(p.references ? { references: p.references } : {}),
            ...(p.unsubscribeUrl ? { headers: { 'List-Unsubscribe': `<${p.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
            messageId: `<${id}@${c.fromEmail.split('@')[1]}>` });
          mime = built.message.toString('base64'); providerMessageId = built.messageId;
        }
        if (!getLead(p.placeId)) throw error(404, 'BUSINESS_NOT_FOUND', 'The business was removed before this email could be sent.');
        policyHooks.assertRecipientAllowed?.(p.to);
        assertSameAccount(row);
        beforeSubmit();
        submitted = true;
        const response = await microsoftRequest(`${GRAPH}/me/sendMail`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': mime ? 'text/plain' : 'application/json', 'client-request-id': id },
          body: mime || JSON.stringify({ message: { subject: p.subject, body: { contentType: 'Text', content: p.text },
            from: { emailAddress: { address: c.fromEmail, name: c.fromName } },
            toRecipients: [{ emailAddress: { address: p.to } }], ...(c.replyTo ? { replyTo: [{ emailAddress: { address: c.replyTo } }] } : {}),
            internetMessageHeaders: [{ name: 'x-local-geni-message-id', value: id }] }, saveToSentItems: true }),
        });
        if (response.status !== 202) {
          if (response.status === 401 || response.status === 403) invalidate(row);
          const uncertain = response.status >= 500 || response.status < 400;
          finish(id, uncertain ? 'unknown' : 'failed', { errorCode: uncertain ? 'PROVIDER_UNCERTAIN' : 'PROVIDER_REJECTED', errorText: uncertain ? 'The provider result is uncertain. Check Sent mail before considering another message.' : 'Microsoft did not accept this message. Check the account permissions, recipient, and provider limits.' });
          return { message: readMessage(id), settings: getSettings() };
        }
      } else {
        transport = await smtp(row);
        if (!getLead(p.placeId)) throw error(404, 'BUSINESS_NOT_FOUND', 'The business was removed before this email could be sent.');
        policyHooks.assertRecipientAllowed?.(p.to);
        assertSameAccount(row);
        beforeSubmit();
        submitted = true;
        const result = await transport.sendMail({ from: { name: c.fromName, address: c.fromEmail }, to: [{ address: p.to }],
          ...(c.replyTo ? { replyTo: { address: c.replyTo } } : {}), envelope: { from: c.fromEmail, to: [p.to] },
          subject: p.subject, text: p.text, ...(p.inReplyTo ? { inReplyTo: p.inReplyTo } : {}), ...(p.references ? { references: p.references } : {}),
          ...(p.unsubscribeUrl ? { headers: { 'List-Unsubscribe': `<${p.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
          messageId: `<${id}@${c.fromEmail.split('@')[1]}>`, disableFileAccess: true, disableUrlAccess: true });
        const accepted = Array.isArray(result?.accepted) && result.accepted.some((a) => String(typeof a === 'string' ? a : a?.address).toLowerCase() === p.to.toLowerCase());
        if (!accepted) {
          const rejected = Array.isArray(result?.rejected) && result.rejected.length > 0;
          finish(id, rejected ? 'failed' : 'unknown', { errorCode: rejected ? 'RECIPIENT_REJECTED' : 'PROVIDER_UNCERTAIN', errorText: rejected ? 'The email provider did not accept this recipient.' : 'The provider result is uncertain. Check Sent mail before considering another message.' });
          return { message: readMessage(id) };
        }
        providerMessageId = `<${id}@${c.fromEmail.split('@')[1]}>`;
      }
      // Provider acceptance and the contacted marker commit together.
      tx(() => {
        finish(id, 'sent', { providerMessageId });
        recordActivityFn(p.placeId, { kind: 'sent', channel: 'email', message: p.text, idempotencyKey: `email:${id}` }, { transaction: false });
      });
      return { message: readMessage(id) };
    } catch (e) {
      const knownFailure = !submitted || ['EAUTH', 'EENVELOPE', 'EDNS', 'ETLS'].includes(e.code)
        || (Number(e.responseCode) >= 400 && Number(e.responseCode) <= 599)
        || ['CONN', 'EHLO', 'HELO', 'STARTTLS', 'AUTH'].some((command) => String(e.command || '').startsWith(command));
      if (e.code === 'EAUTH') invalidate(row);
      const status = knownFailure ? 'failed' : 'unknown';
      const safeCode = e.emailSafe || (!submitted && e.status && typeof e.code === 'string') ? e.code : status === 'unknown' ? 'PROVIDER_UNCERTAIN' : 'EMAIL_SUBMISSION_FAILED';
      finish(id, status, { errorCode: safeCode, errorText: status === 'unknown' ? 'The provider result is uncertain. Check Sent mail before considering another message.' : 'This message was not accepted. Check the sender connection, recipient, and sending limits.' });
      if (!submitted && e.status && (e.emailSafe || typeof e.code === 'string')) throw e;
      return { message: readMessage(id), settings: getSettings() };
    } finally { active.delete(id); transport?.close?.(); }
  }
  const children = new Map();
  function forAccount(id) {
    assertAccountId(id); if (id === accountId) return service;
    if (!children.has(id)) children.set(id, createEmailService({ transportFactory, fetchFn, now, keyProvider, policyHooks, recordActivityFn, getDkimConfig, unsubscribeLink, syncPublicOptOuts, accountId: id, recoverOnStart: false }));
    return children.get(id);
  }
  async function inboxConnection() {
    const row = assertConfigured(); const c = configFor(row); const secret = secretFor(row);
    if (c.provider === 'microsoft') {
      if (!secret.scopes?.includes('mail.read')) throw error(409, 'MICROSOFT_MAIL_READ_REQUIRED', 'Reconnect Microsoft with inbox sync enabled to grant Mail.Read.');
      return { settings: getSettings(), accessToken: await accessToken(row), fetchFn: microsoftRequest };
    }
    return { settings: getSettings(), password: secret.password };
  }
  // Used only by the durable scheduler after matching a stored, explicitly approved snapshot.
  function authorizeScheduled(p, expectedRevision) { const row = assertVerified(); if (row.revision !== expectedRevision) throw error(409, 'EMAIL_ACCOUNT_CHANGED', 'The sender changed. Review this campaign again.'); return { ...p, reviewToken: signReview(reviewBinding(payload(p), row), now() + REVIEW_MS) }; }
  const service = { getSettings, saveSettings, verify, startMicrosoft, pollMicrosoft, cancelMicrosoft, disconnect, listMessages, prepare, sendEmail, forAccount, inboxConnection, authorizeScheduled };
  return service;
}

export const emailService = createEmailService();
