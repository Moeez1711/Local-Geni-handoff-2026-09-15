import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// No real database, credential key file, mail server, Microsoft connection, or email.
process.env.DB_PATH = ':memory:';
const { db } = await import('./db.js');
const { getLead } = await import('./repo.js');
const { createEmailService } = await import('./emailService.js');
const { requireLocalEmailOrigin } = await import('./routes/email.js');
const { config } = await import('./config.js');
const KEY = Buffer.alloc(32, 7);
const APP_ID = '11111111-2222-3333-4444-555555555555';
const SECRET = 'SENSITIVE_TEST_PASSWORD';
let clock = 1800000000000;
let revision = 1;
const policy = { getEmailPolicy: () => ({ revision }), prepareEmailText: (text) => `${text}\n\nReply no thanks to opt out.`, reserveEmailSend: () => ({}) };
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const tokens = (access = 'ACCESS_SENTINEL', refresh = 'REFRESH_SENTINEL', expires = 3600) => ({ access_token: access, refresh_token: refresh, scope: 'User.Read Mail.Send', token_type: 'Bearer', expires_in: expires });
function make(overrides = {}) {
  return createEmailService({ keyProvider: () => KEY, now: () => clock, policyHooks: policy, getDkimConfig: async () => null,
    transportFactory: () => { throw new Error('Unexpected real transport'); }, fetchFn: () => { throw new Error('Unexpected real request'); }, ...overrides });
}
function lead() {
  const id = crypto.randomUUID(); db.prepare('INSERT INTO businesses(place_id,name,first_seen,last_seen) VALUES(?,?,1,1)').run(id, 'Fictional email test business'); return id;
}
const save = (service) => service.saveSettings({ provider: 'gmail', fromName: 'Asif', fromEmail: 'sender@example.com', password: SECRET });
const prepared = (service, placeId = lead()) => service.prepare({ placeId, to: 'Owner@example.com', subject: '  Homepage concept  ', text: '  Here is your new homepage.\n' });
const sendBody = (review) => ({ ...review, idempotencyKey: crypto.randomUUID(), confirmed: true });
test.beforeEach(() => { db.exec('DELETE FROM email_messages; DELETE FROM email_account;'); clock += 100000; revision = 1; });

test('sender secrets are encrypted and masked, and changing identity never reuses a password', () => {
  const service = make();
  assert.equal(save(service).configured, true);
  assert.ok(!JSON.stringify(service.getSettings()).includes(SECRET));
  assert.ok(!db.prepare('SELECT encrypted_secret FROM email_account').get().encrypted_secret.includes(SECRET));
  assert.equal(service.saveSettings({ fromName: 'Asif updated' }).hasSecret, true);
  assert.equal(service.saveSettings({ fromEmail: 'other@example.com', password: '' }).hasSecret, false);
  assert.equal(service.getSettings().verified, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE value LIKE ?").get(`%${SECRET}%`).n, 0);
});

test('SMTP verify enforces TLS, never submits mail, and masks provider errors', async () => {
  let options; let sent = 0;
  const service = make({ transportFactory: (o) => { options = o; return { verify: async () => true, sendMail: async () => { sent++; }, close() {} }; } });
  save(service); assert.equal((await service.verify()).verified, true);
  assert.equal(options.secure, true); assert.equal(options.host, 'smtp.gmail.com'); assert.equal(options.port, 465);
  assert.equal(options.tls.rejectUnauthorized, true); assert.equal(options.disableFileAccess, true); assert.equal(options.disableUrlAccess, true);
  assert.equal(sent, 0);
  const failing = make({ transportFactory: () => ({ verify: async () => { throw new Error(`Server echoed ${SECRET}`); }, close() {} }) });
  await assert.rejects(failing.verify(), (e) => e.code === 'EMAIL_VERIFY_FAILED' && !e.message.includes(SECRET));
});

test('canonical review binds exact content, sender and policy before a successful single send', async () => {
  let message; let sends = 0;
  const service = make({ transportFactory: () => ({ verify: async () => true, sendMail: async (m) => { sends++; message = m; return { accepted: ['Owner@example.com'] }; }, close() {} }) });
  save(service); await service.verify();
  const review = prepared(service); const body = sendBody(review);
  await assert.rejects(service.sendEmail({ ...body, text: `${body.text} changed` }), (e) => e.code === 'EMAIL_REVIEW_REQUIRED');
  assert.equal(sends, 0);
  const sent = await service.sendEmail(body);
  assert.equal(sent.message.status, 'sent'); assert.equal(sends, 1);
  assert.equal(message.text, review.text); assert.equal(message.subject, review.subject);
  assert.deepEqual(message.envelope.to, ['Owner@example.com']);
  assert.equal(getLead(review.placeId).lead_status, 'contacted');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM preview_activity WHERE place_id=? AND kind=?').get(review.placeId, 'sent').n, 1);
  clock += 20 * 60000;
  assert.equal((await service.sendEmail(body)).message.id, sent.message.id);
  assert.equal((await service.sendEmail({ ...body, idempotencyKey: crypto.randomUUID() })).message.id, sent.message.id);
  assert.equal(sends, 1);
});

test('expired review or changed policy cannot send, even with explicit confirmation', async () => {
  const service = make({ transportFactory: () => ({ verify: async () => true, close() {} }) });
  save(service); await service.verify();
  const review = prepared(service);
  revision++;
  await assert.rejects(service.sendEmail(sendBody(review)), (e) => e.code === 'EMAIL_REVIEW_REQUIRED');
  const next = prepared(service); clock += 16 * 60000;
  await assert.rejects(service.sendEmail(sendBody(next)), (e) => e.code === 'EMAIL_REVIEW_REQUIRED');
  assert.equal(service.listMessages().rows.length, 0);
});

test('one-recipient and header validation prevent envelope injection', async () => {
  const service = make({ transportFactory: () => ({ verify: async () => true, close() {} }) });
  save(service); await service.verify();
  const base = { placeId: lead(), to: 'one@example.com', subject: 'Hi', text: 'A website concept.' };
  for (const to of ['one@example.com,two@example.com', 'Name <one@example.com>', 'one@example.com\r\nBcc: two@example.com', 'one..two@example.com']) assert.throws(() => service.prepare({ ...base, to }), (e) => e.status === 400);
  assert.throws(() => service.prepare({ ...base, subject: 'Hi\r\nBcc: two@example.com' }), (e) => e.status === 400);
});

test('ambiguous SMTP outcome is durable, never retried and never marks the lead contacted', async () => {
  let attempts = 0;
  const service = make({ transportFactory: () => ({ verify: async () => true, sendMail: async () => { attempts++; throw Object.assign(new Error(SECRET), { code: 'ECONNECTION', command: 'DATA' }); }, close() {} }) });
  save(service); await service.verify();
  const review = prepared(service); const body = sendBody(review);
  const result = await service.sendEmail(body);
  assert.equal(result.message.status, 'unknown'); assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.equal((await service.sendEmail(body)).message.status, 'unknown'); assert.equal(attempts, 1);
  assert.equal(getLead(review.placeId).last_contacted_at, null);
});

test('a policy rejection occurs before any transport or provider connection', async () => {
  let attempts = 0;
  const service = make({ transportFactory: () => ({ verify: async () => true, sendMail: async () => { attempts++; }, close() {} }), policyHooks: { ...policy, reserveEmailSend: () => { throw Object.assign(new Error('This address is suppressed.'), { status: 409, code: 'RECIPIENT_SUPPRESSED' }); } } });
  save(service); await service.verify();
  const body = sendBody(prepared(service));
  await assert.rejects(service.sendEmail(body), (e) => e.code === 'RECIPIENT_SUPPRESSED');
  assert.equal(attempts, 0); assert.equal(service.listMessages().rows[0].status, 'failed');
  assert.equal((await service.sendEmail(body)).message.status, 'failed');
});

test('Microsoft device flow honors polling, obtains account identity, refreshes tokens and sends once', async () => {
  const requests = []; let tokenCount = 0;
  const service = make({ fetchFn: async (url, options) => {
    requests.push({ url, options }); assert.equal(options.redirect, 'error');
    if (url.endsWith('/devicecode')) return jsonResponse({ device_code: 'DEVICE_SECRET', user_code: 'ABCD1234', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 });
    if (url.endsWith('/token')) { tokenCount++; return jsonResponse(tokenCount === 1 ? tokens('OLD_ACCESS', 'OLD_REFRESH', 61) : tokens('NEW_ACCESS', 'NEW_REFRESH')); }
    if (url.includes('/me?')) return jsonResponse({ mail: 'microsoft@example.com', displayName: 'Microsoft Sender' });
    if (url.endsWith('/sendMail')) return new Response(null, { status: 202 });
    throw new Error('Unexpected request');
  } });
  const start = await service.startMicrosoft({ clientId: APP_ID, tenant: 'common' });
  assert.equal(start.userCode, 'ABCD1234'); assert.ok(!JSON.stringify(start).includes('DEVICE_SECRET'));
  assert.equal((await service.pollMicrosoft()).status, 'pending'); assert.equal(tokenCount, 0);
  clock += 5000;
  const connected = await service.pollMicrosoft();
  assert.equal(connected.status, 'connected'); assert.equal(connected.settings.fromEmail, 'microsoft@example.com'); assert.equal(connected.settings.verified, true);
  assert.ok(!JSON.stringify(connected).includes('OLD_REFRESH'));
  clock += 100000;
  const review = prepared(service); const body = sendBody(review);
  const result = await service.sendEmail(body);
  assert.equal(result.message.status, 'sent'); assert.equal(tokenCount, 2);
  const sendRequest = requests.find((r) => r.url.endsWith('/sendMail'));
  assert.equal(sendRequest.options.headers.Authorization, 'Bearer NEW_ACCESS');
  assert.equal(JSON.parse(sendRequest.options.body).message.body.content, review.text);
  assert.equal(JSON.parse(sendRequest.options.body).message.toRecipients.length, 1);
  assert.equal((await service.sendEmail(body)).message.id, result.message.id);
  assert.equal(requests.filter((r) => r.url.endsWith('/sendMail')).length, 1);
});

test('a cancelled OAuth response cannot restore a disconnected account', async () => {
  let release; const responseReady = new Promise((resolve) => { release = resolve; });
  const service = make({ fetchFn: async (url) => {
    if (url.endsWith('/devicecode')) return jsonResponse({ device_code: 'D', user_code: 'CODE', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 });
    if (url.endsWith('/token')) return responseReady;
    throw new Error('Cancelled response must not fetch a profile');
  } });
  await service.startMicrosoft({ clientId: APP_ID }); clock += 5000;
  const polling = service.pollMicrosoft(); service.disconnect(); release(jsonResponse(tokens()));
  assert.equal((await polling).status, 'expired'); assert.equal(service.getSettings().configured, false);
});

test('local email router guard rejects foreign origins and DNS rebinding', () => {
  const guard = (headers, method = 'POST') => {
    let next = false; let status = 200;
    requireLocalEmailOrigin({ method, get: (key) => headers[key.toLowerCase()] }, { status(n) { status = n; return this; }, json() {}, set() {} }, () => { next = true; });
    return { next, status };
  };
  const host = `127.0.0.1:${config.port}`;
  assert.equal(guard({ host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }).next, true);
  assert.equal(guard({ host, origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' }).next, true);
  assert.equal(guard({ host, origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' }).status, 403);
  assert.equal(guard({ host: `attacker.example:${config.port}`, origin: `http://attacker.example:${config.port}` }).status, 403);
  assert.equal(guard({ host }).status, 403);
});

test('real Nodemailer MIME output contains a cryptographically valid DKIM signature without exposing its private key', async () => {
  const nodemailer = (await import('nodemailer')).default;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  let mime; let composed = 0;
  const service = make({
    unsubscribeLink: () => 'https://preview.example.com/u/opaque-test-token',
    getDkimConfig: async (fromEmail) => {
      assert.equal(fromEmail, 'sender@example.com');
      return { domainName: 'example.com', keySelector: 'localgeni-test', privateKey };
    },
    transportFactory: (options) => {
      // Stream transport exercises Nodemailer's real MIME and DKIM pipeline entirely in memory.
      // The adapter simulates acceptance; there is no SMTP transport or socket.
      const transport = nodemailer.createTransport({ ...options, streamTransport: true, buffer: true, newline: 'windows' });
      return {
        verify: async () => true,
        sendMail: async (message) => {
          const result = await transport.sendMail(message);
          assert.ok(Buffer.isBuffer(result.message));
          mime = result.message.toString('latin1'); composed++;
          return { accepted: result.envelope.to, messageId: result.messageId };
        },
        close: () => transport.close(),
      };
    },
  });
  service.saveSettings({ provider: 'smtp', host: 'smtp.example.com', port: 587, username: 'sender@example.com',
    fromEmail: 'sender@example.com', fromName: 'Asif', replyTo: 'reply@example.com', password: SECRET });
  await service.verify();
  const review = service.prepare({ placeId: lead(), to: 'owner@example.com', subject: 'Homepage concept', text: 'Your redesigned homepage is ready.\nBook a quick call.' });
  const result = await service.sendEmail(sendBody(review));
  assert.equal(result.message.status, 'sent'); assert.equal(composed, 1);
  assert.ok(!mime.includes(SECRET)); assert.ok(!mime.includes(privateKey)); assert.ok(!mime.includes('BEGIN PRIVATE KEY'));

  const separator = mime.indexOf('\r\n\r\n');
  assert.ok(separator > 0);
  const headerLines = mime.slice(0, separator).split(/\r\n(?![ \t])/);
  const headers = headerLines.map((line) => ({ name: line.slice(0, line.indexOf(':')).toLowerCase(), value: line.slice(line.indexOf(':') + 1) }));
  const signature = headers.find((h) => h.name === 'dkim-signature');
  assert.ok(signature);
  const unfold = (value) => value.replace(/\r\n[ \t]+/g, ' ');
  const tags = Object.fromEntries(unfold(signature.value).split(';').map((part) => {
    const index = part.indexOf('='); return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }));
  assert.equal(tags.d, 'example.com'); assert.equal(tags.s, 'localgeni-test');
  assert.equal(tags.a, 'rsa-sha256'); assert.equal(tags.c, 'relaxed/relaxed');
  assert.ok(tags.h.split(':').includes('from'));
  assert.ok(tags.h.split(':').includes('list-unsubscribe'));
  assert.ok(tags.h.split(':').includes('list-unsubscribe-post'));
  assert.equal(headers.filter((h) => h.name === 'to').length, 1);
  assert.equal(headers.find((h) => h.name === 'to').value.trim(), 'owner@example.com');

  // Independently implement RFC 6376 relaxed body canonicalization for these MIME bytes.
  const bodyLines = mime.slice(separator + 4).split('\r\n').map((line) => line.replace(/[ \t]+/g, ' ').replace(/ $/, ''));
  while (bodyLines.at(-1) === '') bodyLines.pop();
  const canonicalBody = bodyLines.length ? `${bodyLines.join('\r\n')}\r\n` : '';
  assert.equal(tags.bh, crypto.createHash('sha256').update(canonicalBody, 'latin1').digest('base64'));

  const relaxedValue = (value) => unfold(value).replace(/[ \t]+/g, ' ').trim();
  const remaining = [...headers];
  const signedHeaders = tags.h.split(':').map((name) => {
    const index = remaining.findLastIndex((header) => header.name === name);
    assert.ok(index >= 0);
    const [header] = remaining.splice(index, 1);
    return `${name}:${relaxedValue(header.value)}\r\n`;
  }).join('');
  const unsignedDkimValue = unfold(signature.value).replace(/(^|;)([ \t]*b=)[^;]*/i, '$1$2');
  const signedBytes = Buffer.from(`${signedHeaders}dkim-signature:${relaxedValue(unsignedDkimValue)}`, 'latin1');
  const signatureBytes = Buffer.from(tags.b.replace(/\s/g, ''), 'base64');
  assert.equal(crypto.verify('RSA-SHA256', signedBytes, publicKey, signatureBytes), true);
  assert.equal(crypto.verify('RSA-SHA256', Buffer.concat([signedBytes, Buffer.from('tampered')]), publicKey, signatureBytes), false);
});

test.after(() => db.close());
