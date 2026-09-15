import test, { beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Independent QA never opens the user's database or contacts a mail provider.
process.env.DB_PATH = ':memory:';
const { config } = await import('./config.js');
assert.equal(config.dbPath, ':memory:');
const { db } = await import('./db.js');
const policy = await import('./emailPolicy.js');
const { createEmailVault } = await import('./emailVault.js');
const { getSettings, getLead } = await import('./repo.js');
const { toCsv } = await import('./export.js');
const { createEmailService } = await import('./emailService.js');
const infrastructure = await import('./emailInfrastructure.js');
const { requireLocalEmailOrigin } = await import('./routes/email.js');
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { assert.fail('QA blocked unexpected real network access'); };
after(() => { globalThis.fetch = realFetch; });

const SECRET = 'QA-SECRET-DO-NOT-EXPOSE-91c0a6';
const vault = createEmailVault({ keyProvider: () => Buffer.alloc(32, 91) });
let clock = Date.UTC(2026, 8, 12, 15);
const realNow = Date.now;
const assertCode = (fn, code) => assert.throws(fn, (error) => error.code === code);
const message = () => policy.prepareEmailText('A homepage concept for your business.');
const reserve = (key, to = 'owner@business.test', text = message()) => policy.reserveEmailSend({ to, idempotencyKey: key, text });

beforeEach(() => {
  Date.now = () => clock;
  db.exec('DELETE FROM email_policy; DELETE FROM email_suppressions; DELETE FROM email_send_reservations; DELETE FROM email_verifications; DELETE FROM email_private_secrets; DELETE FROM email_account; DELETE FROM email_messages; DELETE FROM email_infrastructure;');
});
afterEach(() => { Date.now = realNow; clock = Date.UTC(2026, 8, 12, 15); });

test('QA uses an isolated database; policy and vault leave 634 unrelated saved leads untouched', () => {
  const insert = db.prepare('INSERT INTO businesses(place_id,name,first_seen,last_seen,notes) VALUES(?,?,1,1,?)');
  for (let index = 0; index < 634; index++) insert.run(`qa-control-${index}`, `Existing business ${index}`, 'Keep this existing note');
  const digest = () => crypto.createHash('sha256').update(JSON.stringify(db.prepare("SELECT * FROM businesses WHERE place_id LIKE 'qa-control-%' ORDER BY place_id").all())).digest('hex');
  const before = digest();
  vault.set('qa.secret', { password: SECRET, refreshToken: `${SECRET}-refresh` });
  policy.addSuppression({ email: 'owner@business.test', reason: 'opt_out' });
  policy.updateEmailPolicy({ paused: true });
  assert.equal(digest(), before);
  assert.equal(db.prepare("SELECT count(*) AS n FROM businesses WHERE place_id LIKE 'qa-control-%'").get().n, 634);
});

test('stored secrets are encrypted, excluded from generic settings and exports, and context authenticated', () => {
  vault.set('qa.account', { password: SECRET, refreshToken: `${SECRET}-refresh` });
  const envelope = db.prepare("SELECT encrypted_value FROM email_private_secrets WHERE name='qa.account'").get().encrypted_value;
  assert.ok(!envelope.includes(SECRET));
  assert.equal(vault.get('qa.account').password, SECRET);
  assert.ok(!JSON.stringify(getSettings()).includes(SECRET));
  db.prepare('INSERT INTO businesses(place_id,name,first_seen,last_seen) VALUES(?,?,1,1)').run('qa-export-control', 'Export control');
  assert.ok(!toCsv([getLead('qa-export-control')]).includes(SECRET));
  assert.throws(() => vault.open(envelope, 'qa.other'), (error) => error.code === 'EMAIL_KEY_UNAVAILABLE' && !error.message.includes(SECRET));
  const wrongKey = createEmailVault({ keyProvider: () => Buffer.alloc(32, 92) });
  assert.throws(() => wrongKey.get('qa.account'), (error) => error.code === 'EMAIL_KEY_UNAVAILABLE');
});

test('recipient normalization permits one mailbox and rejects additional recipients or header injection', () => {
  assert.equal(policy.normalizeEmail(' Owner+Site@Business.Test '), 'owner+site@business.test');
  for (const value of ['a@business.test,b@business.test', 'a@business.test; b@business.test', 'Owner <a@business.test>', 'a@business.test\r\nBcc:b@business.test', 'a..b@business.test', ['a@business.test'], { address: 'a@business.test' }]) {
    assertCode(() => policy.normalizeEmail(value), 'INVALID_EMAIL');
  }
});

test('case-insensitive suppression blocks sending before reserving a slot', () => {
  policy.addSuppression({ email: 'Owner@Business.Test', reason: 'opt_out' });
  assertCode(() => reserve('qa-suppression', 'OWNER@business.test'), 'RECIPIENT_SUPPRESSED');
  assert.equal(policy.getPolicyStatus().usage.daily, 0);
  policy.removeSuppression('owner@BUSINESS.test');
  reserve('qa-after-unsuppress');
  assert.equal(policy.getPolicyStatus().usage.daily, 1);
});

test('simultaneous distinct send reservations cannot bypass the spacing rule', async () => {
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => Promise.resolve().then(() => reserve(`qa-concurrent-${index}`, `owner${index}@business.test`))));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter((result) => result.status === 'rejected').every((result) => result.reason.code === 'SEND_LIMIT'));
  assert.equal(policy.getPolicyStatus().usage.daily, 1);
});

test('rolling limits include reserved attempts and idempotent retries do not consume extra slots', () => {
  policy.updateEmailPolicy({ hourlyLimit: 2, dailyLimit: 3, minIntervalSeconds: 30 });
  reserve('qa-first-send');
  reserve('qa-first-send');
  assert.equal(policy.getPolicyStatus().usage.daily, 1);
  assertCode(() => reserve('qa-first-send', 'different@business.test'), 'DUPLICATE_REQUEST');
  clock += 31000; reserve('qa-second-send');
  clock += 31000; assertCode(() => reserve('qa-third-send'), 'SEND_LIMIT');
  assert.equal(policy.getPolicyStatus().usage.hourly, 2);
  clock += 3600000; reserve('qa-third-send');
  clock += 31000; assertCode(() => reserve('qa-fourth-send'), 'SEND_LIMIT');
  clock += 86400000; reserve('qa-fourth-send');
  assert.equal(policy.getPolicyStatus().usage.daily, 1);
});

test('reviewed opt-out text is included exactly once and stale policy text cannot be sent', () => {
  const prepared = message();
  const footer = policy.getEmailPolicy().optOutText;
  assert.ok(prepared.endsWith(footer));
  assert.equal(policy.prepareEmailText(prepared), prepared);
  const oldRevision = policy.getEmailPolicy().revision;
  policy.updateEmailPolicy({ optOutText: 'Reply stop and I will not contact you again.' });
  assert.ok(policy.getEmailPolicy().revision > oldRevision);
  assertCode(() => reserve('qa-stale-review', 'owner@business.test', prepared), 'REVIEW_REQUIRED');
  assert.equal(policy.getPolicyStatus().usage.daily, 0);
});

test('domain-only checks cannot satisfy required successful mailbox verification', () => {
  policy.updateEmailPolicy({ requireMailboxVerification: true });
  const store = db.prepare('INSERT OR REPLACE INTO email_verifications VALUES(?,?,?)');
  store.run('owner@business.test', JSON.stringify({ status: 'deliverable', mode: 'domain' }), clock);
  assertCode(() => reserve('qa-domain-only'), 'VERIFICATION_REQUIRED');
  store.run('owner@business.test', JSON.stringify({ status: 'deliverable', mode: 'mailbox' }), clock - 31 * 86400000);
  assertCode(() => reserve('qa-stale-mailbox'), 'VERIFICATION_REQUIRED');
  store.run('owner@business.test', JSON.stringify({ status: 'deliverable', mode: 'mailbox' }), clock);
  reserve('qa-good-mailbox');
});

test('paused sending and recent invalid verification reserve no send slots', () => {
  policy.updateEmailPolicy({ paused: true });
  assertCode(() => reserve('qa-paused-send'), 'SENDING_PAUSED');
  policy.updateEmailPolicy({ paused: false });
  db.prepare('INSERT INTO email_verifications VALUES(?,?,?)').run('owner@business.test', JSON.stringify({ status: 'invalid', mode: 'mailbox' }), clock);
  assertCode(() => reserve('qa-invalid-mailbox'), 'RECIPIENT_INVALID');
  assert.equal(policy.getPolicyStatus().usage.daily, 0);
});

let leadNumber = 0;
function emailLead() {
  const placeId = `qa-email-${++leadNumber}`;
  db.prepare('INSERT INTO businesses(place_id,name,first_seen,last_seen,emails) VALUES(?,?,1,1,?)').run(placeId, 'QA email business', '["owner@business.test"]');
  return placeId;
}
function fakeService({ sendMail, verify, fetchFn, ...hooks } = {}) {
  const captured = { options: [], emails: [], closed: 0, fetches: [] };
  const service = createEmailService({
    keyProvider: () => Buffer.alloc(32, 91), now: () => clock, getDkimConfig: async () => null,
    transportFactory: async (options) => {
      captured.options.push(options);
      return {
        verify: verify || (async () => true),
        sendMail: async (body) => { captured.emails.push(body); return sendMail ? sendMail(body) : { accepted: [body.to[0].address], messageId: 'provider-id' }; },
        close: () => { captured.closed++; },
      };
    },
    fetchFn: async (...args) => { captured.fetches.push(args); assert.ok(fetchFn, 'No Microsoft request expected'); return fetchFn(...args); },
    ...hooks,
  });
  return { service, captured };
}
async function connectedService(options = {}, provider = 'gmail') {
  const result = fakeService(options);
  result.service.saveSettings({ provider, fromEmail: 'sender@agency.test', fromName: 'Asif', password: SECRET,
    ...(provider === 'smtp' ? { host: 'smtp.agency.test', port: 587, username: 'sender@agency.test' } : {}) });
  await result.service.verify();
  return result;
}
function preparedSend(service, placeId = emailLead(), key = `qa-send-${leadNumber}`) {
  return { ...service.prepare({ placeId, to: 'owner@business.test', subject: 'A homepage concept', text: '  Hi, here is a personal homepage idea.\n' }), idempotencyKey: key, confirmed: true };
}
const deferred = () => { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

test('origin guard rejects cross-site, DNS rebinding, null origins and untrusted local ports', () => {
  function allowed(headers, method = 'POST') {
    let passed = false; let status = 200;
    const req = { method, get: (name) => headers[name.toLowerCase()] };
    const res = { status(value) { status = value; return this; }, json() { return this; }, set() { return this; } };
    requireLocalEmailOrigin(req, res, () => { passed = true; });
    return { passed, status };
  }
  const host = `127.0.0.1:${config.port}`;
  assert.equal(allowed({ host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }).passed, true);
  assert.equal(allowed({ host, origin: 'http://localhost:5173' }).passed, true);
  for (const headers of [
    { host, origin: 'https://evil.test' }, { host: `evil.test:${config.port}`, origin: `http://evil.test:${config.port}` },
    { host, origin: 'null' }, { host, origin: 'http://localhost:9000' }, { host, 'sec-fetch-site': 'cross-site' },
    { host }, { host, origin: `http://${host}/malicious-path` },
  ]) assert.deepEqual(allowed(headers), { passed: false, status: 403 });
});

test('SMTP transport requires TLS and sends only the reviewed one-recipient plain-text body', async () => {
  const { service, captured } = await connectedService({}, 'smtp');
  const request = preparedSend(service);
  const result = await service.sendEmail({ ...request, attachments: [{ path: '/private/secrets' }], html: '<img src="https://evil.test/track">', cc: 'other@business.test', bcc: 'hidden@business.test' });
  assert.equal(result.message.status, 'sent');
  assert.equal(result.message.text, request.text);
  assert.equal(result.message.subject, request.subject);
  assert.equal(getLead(request.placeId).lead_status, 'contacted');
  assert.ok(getLead(request.placeId).last_contacted_at);
  const sentBody = captured.emails[0];
  assert.deepEqual(sentBody.to, [{ address: request.to }]);
  assert.deepEqual(sentBody.envelope.to, [request.to]);
  assert.equal(sentBody.text, request.text);
  for (const field of ['attachments', 'html', 'cc', 'bcc']) assert.equal(sentBody[field], undefined);
  for (const options of captured.options) {
    assert.equal(options.port, 587); assert.equal(options.requireTLS, true); assert.equal(options.ignoreTLS, false);
    assert.equal(options.tls.rejectUnauthorized, true); assert.equal(options.tls.minVersion, 'TLSv1.2');
    assert.equal(options.disableFileAccess, true); assert.equal(options.disableUrlAccess, true); assert.equal(options.logger, false);
  }
  assert.ok(!JSON.stringify(service.getSettings()).includes(SECRET));
  assert.ok(!JSON.stringify(service.listMessages()).includes(SECRET));
  assert.equal(db.prepare('SELECT message FROM preview_activity WHERE place_id=? AND kind=?').get(request.placeId, 'sent').message, request.text);
  assert.equal(result.message.delivered, undefined);
});

test('review tokens bind the final text, recipient, subject, sender revision and sending policy', async () => {
  const { service, captured } = await connectedService();
  const request = preparedSend(service);
  for (const mutation of [{ to: 'different@business.test' }, { subject: 'Changed after review' }, { text: `${request.text}\nChanged` }]) {
    await assert.rejects(service.sendEmail({ ...request, ...mutation }), (error) => error.code === 'EMAIL_REVIEW_REQUIRED');
  }
  policy.updateEmailPolicy({ paused: true });
  await assert.rejects(service.sendEmail(request), (error) => error.code === 'EMAIL_REVIEW_REQUIRED');
  policy.updateEmailPolicy({ paused: false });
  const next = preparedSend(service, request.placeId, 'qa-revised-sender');
  service.saveSettings({ fromName: 'Different sender name' });
  await service.verify();
  await assert.rejects(service.sendEmail(next), (error) => error.code === 'EMAIL_REVIEW_REQUIRED');
  assert.equal(captured.emails.length, 0);
  assert.equal(policy.getPolicyStatus().usage.daily, 0);
});

test('headers reject CRLF and extra recipients before any transport submission', async () => {
  const { service, captured } = await connectedService();
  const base = { placeId: emailLead(), to: 'owner@business.test', subject: 'One subject', text: 'One message' };
  for (const body of [{ ...base, to: 'a@business.test,b@business.test' }, { ...base, to: 'a@business.test\r\nBcc:b@business.test' }, { ...base, subject: 'Hi\r\nBcc: hidden@business.test' }]) assert.throws(() => service.prepare(body));
  assert.throws(() => service.saveSettings({ fromName: 'Asif\r\nReply-To: other@business.test' }));
  assert.throws(() => service.saveSettings({ provider: 'smtp', host: 'smtp.agency.test', port: 25, username: 'user' }));
  assert.equal(captured.emails.length, 0);
});

test('concurrent identical sends hold one durable idempotency lock and contact the business once', async () => {
  const gate = deferred();
  const { service, captured } = await connectedService({ sendMail: () => gate.promise });
  const request = preparedSend(service);
  const first = service.sendEmail(request);
  const second = await service.sendEmail(request);
  assert.equal(second.message.status, 'sending');
  gate.resolve({ accepted: [request.to] });
  const done = await first;
  assert.equal(done.message.status, 'sent');
  assert.equal(captured.emails.length, 1);
  assert.equal((await service.sendEmail(request)).message.id, done.message.id);
  assert.equal(captured.emails.length, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM preview_activity WHERE place_id=? AND kind=?').get(request.placeId, 'sent').n, 1);
  assert.equal(policy.getPolicyStatus().usage.daily, 1);
});

test('a consumed final review cannot submit the same email under a fresh request key', async () => {
  const { service, captured } = await connectedService();
  const request = preparedSend(service);
  const first = await service.sendEmail(request);
  clock += 121000;
  const replay = await service.sendEmail({ ...request, idempotencyKey: 'qa-new-key-same-review' });
  assert.equal(replay.message.id, first.message.id);
  assert.equal(captured.emails.length, 1);
  assert.equal(policy.getPolicyStatus().usage.daily, 1);
});

test('a definitive failure can be retried only as a fresh reviewed attempt and fresh request', async () => {
  let reject = true;
  const { service, captured } = await connectedService({ sendMail: async (body) => reject ? { accepted: [], rejected: [body.to[0].address] } : { accepted: [body.to[0].address] } });
  const request = preparedSend(service);
  const failed = await service.sendEmail(request);
  assert.equal(failed.message.status, 'failed');
  reject = false; clock += 121000;
  const repeated = await service.sendEmail(request);
  assert.equal(repeated.message.status, 'failed');
  assert.equal(captured.emails.length, 1);
  const fresh = { ...service.prepare({ placeId: request.placeId, to: request.to, subject: request.subject, text: request.text }), confirmed: true, idempotencyKey: 'qa-fresh-reviewed-attempt' };
  const accepted = await service.sendEmail(fresh);
  assert.equal(accepted.message.status, 'sent');
  assert.notEqual(accepted.message.id, failed.message.id);
  assert.equal(captured.emails.length, 2);
});

test('failure to commit outreach after provider acceptance stays uncertain and does not retry', async () => {
  const { service, captured } = await connectedService({ recordActivityFn: () => { throw new Error('Simulated local persistence failure'); } });
  const request = preparedSend(service);
  const result = await service.sendEmail(request);
  assert.equal(result.message.status, 'unknown');
  assert.equal(getLead(request.placeId).last_contacted_at, null);
  assert.equal((await service.sendEmail(request)).message.id, result.message.id);
  assert.equal(captured.emails.length, 1);
});

test('unknown provider outcomes are redacted, never mark contacted, and never auto-retry', async () => {
  const { service, captured } = await connectedService({ sendMail: async () => { throw Object.assign(new Error(`Provider exposed ${SECRET}`), { code: 'ETIMEDOUT', command: 'DATA' }); } });
  const request = preparedSend(service);
  const first = await service.sendEmail(request);
  assert.equal(first.message.status, 'unknown');
  assert.equal(getLead(request.placeId).lead_status, 'not_contacted');
  assert.equal(getLead(request.placeId).last_contacted_at, null);
  assert.equal((await service.sendEmail(request)).message.id, first.message.id);
  assert.equal(captured.emails.length, 1);
  assert.ok(!JSON.stringify(first).includes(SECRET));
  assert.ok(!JSON.stringify(service.listMessages()).includes(SECRET));
});

test('connection loss during DATA remains unknown rather than claiming the message was not sent', async () => {
  const { service } = await connectedService({ sendMail: async () => { throw Object.assign(new Error('Socket closed after message body'), { code: 'ECONNECTION', command: 'DATA' }); } });
  const request = preparedSend(service);
  const result = await service.sendEmail(request);
  assert.equal(result.message.status, 'unknown');
  assert.equal(getLead(request.placeId).last_contacted_at, null);
});

test('definitive rejection never marks contacted and does not leak the provider error', async () => {
  const { service } = await connectedService({ sendMail: async () => { throw Object.assign(new Error(SECRET), { code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' }); } });
  const request = preparedSend(service);
  const result = await service.sendEmail(request);
  assert.equal(result.message.status, 'failed');
  assert.equal(getLead(request.placeId).last_contacted_at, null);
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('settings cannot change while verification is in flight', async () => {
  const gate = deferred();
  const { service } = fakeService({ verify: () => gate.promise });
  service.saveSettings({ provider: 'gmail', fromEmail: 'sender@agency.test', password: SECRET });
  const verifying = service.verify();
  assertCode(() => service.saveSettings({ fromEmail: 'different@agency.test', password: 'replacement' }), 'EMAIL_BUSY');
  assertCode(() => service.disconnect(), 'EMAIL_BUSY');
  gate.resolve(true);
  assert.equal((await verifying).fromEmail, 'sender@agency.test');
});

const CLIENT_ID = '00000000-0000-4000-8000-000000000001';
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const deviceResponse = () => jsonResponse({ device_code: 'QA-PRIVATE-DEVICE-CODE', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 });
const tokenResponse = (scope = 'User.Read Mail.Send offline_access') => jsonResponse({ access_token: SECRET, refresh_token: `${SECRET}-refresh`, token_type: 'Bearer', expires_in: 3600, scope });

test('Microsoft sign-in pins fixed endpoints/scopes and derives sender from the authenticated profile', async () => {
  const { service, captured } = fakeService({ fetchFn: async (url) => {
    if (url.endsWith('/devicecode')) return deviceResponse();
    if (url.endsWith('/token')) return tokenResponse();
    if (url.includes('/me?')) return jsonResponse({ mail: 'real-sender@agency.test', displayName: 'Real sender' });
    if (url.endsWith('/me/sendMail')) return new Response(null, { status: 202 });
    assert.fail('Unexpected Microsoft endpoint');
  } });
  await assert.rejects(service.startMicrosoft({ clientId: CLIENT_ID, tenant: '../evil.test/path' }), (error) => error.code === 'INVALID_TENANT');
  await assert.rejects(service.startMicrosoft({ clientId: 'https://evil.test', tenant: 'common' }), (error) => error.code === 'INVALID_CLIENT_ID');
  assert.equal(captured.fetches.length, 0);
  const start = await service.startMicrosoft({ clientId: CLIENT_ID, tenant: 'common' });
  assert.equal(start.deviceCode, undefined);
  const scopes = new URLSearchParams(captured.fetches[0][1].body).get('scope');
  assert.ok(scopes.includes('Mail.Send')); assert.ok(scopes.includes('User.Read')); assert.ok(scopes.includes('offline_access'));
  assert.equal((await service.pollMicrosoft()).status, 'pending');
  clock += 6000;
  const connected = await service.pollMicrosoft();
  assert.equal(connected.status, 'connected');
  assert.equal(connected.settings.fromEmail, 'real-sender@agency.test');
  assert.ok(!JSON.stringify(connected).includes(SECRET));
  const request = preparedSend(service);
  const accepted = await service.sendEmail(request);
  assert.equal(accepted.message.status, 'sent');
  assert.equal(accepted.message.delivered, undefined);
  const [url, options] = captured.fetches.find(([target]) => target.endsWith('/me/sendMail'));
  assert.equal(url, 'https://graph.microsoft.com/v1.0/me/sendMail');
  assert.equal(options.redirect, 'error');
  const body = JSON.parse(options.body);
  assert.equal(body.message.body.contentType, 'Text');
  assert.equal(body.message.body.content, request.text);
  assert.deepEqual(body.message.toRecipients, [{ emailAddress: { address: request.to } }]);
  assert.equal(body.saveToSentItems, true);
});

test('Microsoft missing consent cannot verify a sender, and cancelled polling cannot revive a connection', async () => {
  let tokenGate = null;
  const { service } = fakeService({ fetchFn: async (url) => {
    if (url.endsWith('/devicecode')) return deviceResponse();
    if (url.endsWith('/token')) return tokenGate ? tokenGate.promise : tokenResponse('User.Read');
    if (url.includes('/me?')) return jsonResponse({ mail: 'sender@agency.test' });
    assert.fail('Unexpected Microsoft endpoint');
  } });
  await service.startMicrosoft({ clientId: CLIENT_ID }); clock += 6000;
  await assert.rejects(service.pollMicrosoft(), (error) => error.code === 'MICROSOFT_SCOPE_REQUIRED');
  assert.equal(service.getSettings().verified, false);
  await service.startMicrosoft({ clientId: CLIENT_ID }); clock += 6000;
  tokenGate = deferred(); const pendingPoll = service.pollMicrosoft();
  service.cancelMicrosoft(); tokenGate.resolve(tokenResponse());
  assert.equal((await pendingPoll).status, 'expired');
  assert.equal(service.getSettings().verified, false);
  assert.equal(service.getSettings().configured, false);
});

function fakeDns({ txt = {}, mx = [{ priority: 10, exchange: 'mx.agency.com' }] } = {}) {
  return {
    resolveMx: async () => mx,
    resolveTxt: async (name) => { if (name in txt) return txt[name].map((record) => [record]); throw Object.assign(new Error('No record'), { code: 'ENODATA' }); },
    resolve4: async () => [], resolve6: async () => [],
  };
}

test('DNS-only verification cannot erase a recent invalid mailbox verdict or claim mailbox deliverability', async () => {
  const email = 'owner@agency.com';
  db.prepare('INSERT INTO email_verifications VALUES(?,?,?)').run(email, JSON.stringify({ email, mode: 'mailbox', status: 'invalid', checkedAt: clock }), clock);
  const result = await infrastructure.verifyRecipient({ email, mode: 'dns', force: true }, { dns: fakeDns(), fetchImpl: async () => assert.fail('DNS check must not contact mailbox provider') });
  assert.equal(result.status, 'domain_valid');
  assert.equal(result.mode, 'dns');
  assert.match(result.summary, /has not been verified/);
  assert.equal(JSON.parse(db.prepare('SELECT result FROM email_verifications WHERE email=?').get(email).result).status, 'invalid');
  assertCode(() => policy.assertRecipientAllowed(email), 'RECIPIENT_INVALID');
});

test('DNS plans preserve legitimate SPF senders and refuse to create a third conflicting SPF record', async () => {
  infrastructure.saveInfrastructureSettings({ domain: 'agency.com', provider: 'gmail', selector: 'localgeni' });
  await infrastructure.checkDomain({}, { dns: fakeDns({ txt: { 'agency.com': ['v=spf1 include:mail.agency.com -all'] } }) });
  let spf = infrastructure.buildDnsPlan().records.find((record) => record.name === 'agency.com');
  assert.equal(spf.value, 'v=spf1 include:mail.agency.com include:_spf.google.com -all');
  await infrastructure.checkDomain({}, { dns: fakeDns({ txt: { 'agency.com': ['v=spf1 include:one.agency.com -all', 'v=spf1 include:two.agency.com -all'] } }) });
  spf = infrastructure.buildDnsPlan().records.find((record) => record.name === 'agency.com');
  assert.equal(spf.value, '');
});

test('DKIM validation rejects a matching RSA public key declared as an unsupported algorithm', async () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const encoded = publicKey.toString('base64');
  db.prepare('INSERT INTO email_infrastructure VALUES(?,?)').run('dkim', JSON.stringify({ domain: 'agency.com', selector: 'localgeni', publicRecord: `v=DKIM1; k=rsa; p=${encoded}`, enabled: false, verifiedAt: null, createdAt: clock }));
  const dns = fakeDns({ txt: { 'localgeni._domainkey.agency.com': [`v=DKIM1; k=ed25519; p=${encoded}`] } });
  const audit = await infrastructure.checkDomain({ domain: 'agency.com', selector: 'localgeni' }, { dns });
  assert.equal(audit.checks.find((check) => check.key === 'dkim').status, 'issue');
  await assert.rejects(infrastructure.setDkimEnabled(true, { dns }), (error) => error.code === 'DKIM_DNS_MISMATCH');
});

test('DMARC duplicate policy tags are reported as an issue rather than a valid published policy', async () => {
  const result = await infrastructure.checkDomain({ domain: 'agency.com', selector: 'localgeni' }, { dns: fakeDns({ txt: { '_dmarc.agency.com': ['v=DMARC1; p=none; p=reject;'] } }) });
  assert.equal(result.checks.find((check) => check.key === 'dmarc').status, 'issue');
});

test('a slower DNS lookup cannot overwrite a mailbox-invalid verdict saved while it was in flight', async () => {
  const email = 'race@agency.com';
  const gate = deferred();
  const checking = infrastructure.verifyRecipient({ email, mode: 'dns', force: true }, { dns: { ...fakeDns(), resolveMx: () => gate.promise } });
  db.prepare('INSERT INTO email_verifications VALUES(?,?,?)').run(email, JSON.stringify({ email, mode: 'mailbox', status: 'invalid', checkedAt: clock }), clock);
  gate.resolve([{ priority: 10, exchange: 'mx.agency.com' }]);
  await checking;
  const stored = JSON.parse(db.prepare('SELECT result FROM email_verifications WHERE email=?').get(email).result);
  assert.equal(stored.mode, 'mailbox');
  assert.equal(stored.status, 'invalid');
  assertCode(() => policy.assertRecipientAllowed(email), 'RECIPIENT_INVALID');
});

test('an older DKIM DNS refresh cannot silently re-enable signing after it was disabled', async () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const record = `v=DKIM1; k=rsa; p=${publicKey.toString('base64')}`;
  db.prepare('INSERT INTO email_infrastructure VALUES(?,?)').run('dkim', JSON.stringify({ domain: 'agency.com', selector: 'localgeni', publicRecord: record, enabled: true, verifiedAt: clock - 7200000, createdAt: clock }));
  const gate = deferred();
  const dns = fakeDns({ txt: { 'localgeni._domainkey.agency.com': [record] } });
  const originalTxt = dns.resolveTxt;
  dns.resolveTxt = async (name) => name.includes('._domainkey.') ? gate.promise : originalTxt(name);
  const enabling = infrastructure.setDkimEnabled(true, { dns }).catch((error) => error);
  let disableResult;
  try { disableResult = await infrastructure.setDkimEnabled(false); }
  catch (error) { assert.ok(error.status === 409, 'Concurrent disable must report an explicit conflict'); }
  gate.resolve([[record]]);
  await enabling;
  if (disableResult) assert.equal(JSON.parse(db.prepare("SELECT value FROM email_infrastructure WHERE key='dkim'").get().value).enabled, false);
});
