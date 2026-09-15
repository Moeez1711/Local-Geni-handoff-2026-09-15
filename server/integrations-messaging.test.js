import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.DB_PATH = ':memory:';
const { db } = await import('./db.js');
const { createIntegrationService, INTEGRATIONS } = await import('./integrations.js');
const { createSmsService } = await import('./sms.js');
const { createAssistantService } = await import('./assistant.js');
const { workspaceRoutePermission } = await import('./auth.js');
const { createIntegrationsQaProvider } = await import('../scripts/integrations-qa-provider.mjs');
const { smsLength } = await import('../shared/sms.js');
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const fixture = { apiKey: 'QA_KEY_PRIVATE', apiSecret: 'QA_SECRET_PRIVATE', accountSid: `AC${'a'.repeat(32)}`, authToken: 'QA_TOKEN_PRIVATE', fromNumber: '+14165550100' };
const input = (provider = 'twilio') => ({ provider, connectionRevision: db.prepare('SELECT revision FROM integration_connections WHERE id=?').get(provider)?.revision, requestId: crypto.randomUUID(), recipient: '+14165550123', body: 'A fictional QA message.', consent: true, confirmed: true });
beforeEach(() => { db.exec('DELETE FROM integration_connections; DELETE FROM sms_messages; DELETE FROM sms_suppressions;'); });
test('SMS lengths account for GSM extensions and Unicode pairs', () => {
  assert.deepEqual(smsLength('Hello'), { unicode: false, units: 5, segments: 1 });
  assert.equal(smsLength('a'.repeat(161)).segments, 2);
  assert.equal(smsLength('^'.repeat(81)).segments, 2);
  assert.deepEqual(smsLength('😀'.repeat(36)), { unicode: true, units: 72, segments: 2 });
});
async function connected(provider, fetchFn = createIntegrationsQaProvider()) {
  const integrations = createIntegrationService({ fetchFn });
  integrations.save(provider, fixture); await integrations.verify(provider); return integrations;
}
test('all 14 connections verify without exposing credentials', async () => {
  const integrations = createIntegrationService({ fetchFn: createIntegrationsQaProvider(), simulated: true });
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serviceAccount = JSON.stringify({ type: 'service_account', client_email: 'qa@fixture.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://untrusted.example/token' });
  for (const item of INTEGRATIONS) {
    assert.equal(integrations.save(item.id, { ...fixture, serviceAccount, resourceId: 'qa_document_123456' }).verified, false);
    assert.equal((await integrations.verify(item.id)).verified, true, item.id);
  }
  const serialized = JSON.stringify(integrations.list());
  for (const secret of [fixture.apiKey, fixture.apiSecret, fixture.authToken, 'PRIVATE KEY']) assert.ok(!serialized.includes(secret));
  const encrypted = db.prepare('SELECT secret FROM integration_connections').all();
  assert.ok(encrypted.every(row => !row.secret.includes('QA_KEY_PRIVATE')));
  assert.equal(integrations.list().simulated, true);
});
test('provider URLs are fixed and Google ignores untrusted token_uri', async () => {
  const calls = [], mock = createIntegrationsQaProvider();
  const integrations = createIntegrationService({ fetchFn: async (url, options) => { calls.push([url, options]); return mock(url, options); } });
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  integrations.save('google-docs', { serviceAccount: JSON.stringify({ type: 'service_account', client_email: 'qa@fixture.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'http://127.0.0.1/secrets' }), resourceId: 'qa_document_123456' });
  await integrations.verify('google-docs');
  assert.equal(calls[0][0], 'https://oauth2.googleapis.com/token');
  assert.ok(calls.every(([, options]) => options.redirect === 'error'));
  const jwt = new URLSearchParams(calls[0][1].body).get('assertion').split('.')[1];
  assert.equal(JSON.parse(Buffer.from(jwt, 'base64url')).scope, 'https://www.googleapis.com/auth/documents.readonly');
});
test('credential edits invalidate verification and blank values retain secrets', async () => {
  const integrations = await connected('slack');
  integrations.save('slack', { apiKey: '' });
  assert.equal(integrations.status('slack').verified, false);
  assert.equal(integrations.credentials('slack').apiKey, fixture.apiKey);
  integrations.disconnect('slack');
  assert.equal(integrations.status('slack').configured, false);
});
test('stale credential verification cannot mark a replacement connected', async () => {
  let release;
  const integrations = createIntegrationService({ fetchFn: () => new Promise(resolve => { release = resolve; }) });
  integrations.save('slack', fixture);
  const pending = integrations.verify('slack');
  integrations.save('slack', { apiKey: 'NEW_QA_KEY' });
  release(response({ ok: true, team_id: 'QA_TEAM' }));
  await assert.rejects(pending, /changed during verification/);
  assert.equal(integrations.status('slack').verified, false);
});
test('credential and upstream response errors never echo provider secrets', async () => {
  const integrations = createIntegrationService({ fetchFn: async () => response({ error: fixture.apiKey }, 401) });
  integrations.save('slack', fixture);
  await assert.rejects(integrations.verify('slack'), error => !error.message.includes(fixture.apiKey));
  assert.ok(!JSON.stringify(integrations.status('slack')).includes(fixture.apiKey));
  assert.throws(() => integrations.save('twilio', { ...fixture, accountSid: '../../bad' }), /Account SID/);
});
for (const provider of ['twilio', 'telnyx', 'vonage']) test(`${provider}: submit once, then read status`, async () => {
  const integrations = await connected(provider), calls = [], mock = createIntegrationsQaProvider();
  const sms = createSmsService({ integrations, fetchFn: async (url, options) => { calls.push([url, options]); return mock(url, options); } });
  const request = input(provider), sent = await sms.send(request), duplicate = await sms.send(request);
  assert.equal(calls.length, 1);
  assert.equal(duplicate.message.id, sent.message.id);
  assert.equal(duplicate.duplicate, true);
  assert.ok(['accepted', 'queued'].includes(sent.message.status));
  assert.equal((await sms.refresh(sent.message.id)).message.status, provider === 'vonage' ? 'accepted' : 'delivered');
  await assert.rejects(sms.send({ ...request, body: 'Changed message' }), /different message/);
});
test('ambiguous SMS failures remain unknown and never automatically retry', async () => {
  const integrations = await connected('twilio'); let count = 0;
  const sms = createSmsService({ integrations, fetchFn: async () => { count++; throw new Error('connection ended'); } });
  const request = input();
  assert.equal((await sms.send(request)).message.status, 'unknown');
  assert.equal((await sms.send(request)).duplicate, true);
  assert.equal(count, 1);
});
test('SMS permission, confirmation and blocked recipients are enforced server-side', async () => {
  const integrations = await connected('twilio'); let count = 0;
  const sms = createSmsService({ integrations, fetchFn: async () => { count++; } });
  await assert.rejects(sms.send({ ...input(), consent: false }), /permission/);
  await assert.rejects(sms.send({ ...input(), confirmed: false }), /Confirm/);
  sms.suppress('+14165550123');
  await assert.rejects(sms.send(input()), /blocked/);
  assert.equal(count, 0);
});
test('concurrent duplicate SMS requests do not submit twice', async () => {
  const integrations = await connected('twilio'); let release, count = 0;
  const sms = createSmsService({ integrations, fetchFn: () => { count++; return new Promise(resolve => { release = resolve; }); } });
  const request = input(), first = sms.send(request);
  assert.equal((await sms.send(request)).message.status, 'submitting');
  release(response({ sid: `SM${'b'.repeat(32)}`, status: 'queued' }));
  await first; assert.equal(count, 1);
});
test('changing the connection after review cannot silently replace the SMS sender', async () => {
  const integrations = await connected('twilio'), reviewed = input();
  integrations.save('twilio', { ...fixture, fromNumber: '+14165550200' }); await integrations.verify('twilio');
  let count = 0;
  const sms = createSmsService({ integrations, fetchFn: async () => { count++; } });
  await assert.rejects(sms.send(reviewed), /connection changed/);
  assert.equal(count, 0);
});
for (const provider of ['anthropic', 'openai', 'gemini']) test(`${provider}: assistant uses models and read-only context`, async () => {
  const integrations = await connected(provider), calls = [], mock = createIntegrationsQaProvider();
  const assistant = createAssistantService({ integrations, fetchFn: async (url, options) => { calls.push([url, options]); return mock(url, options); } });
  const { rows } = await assistant.models(provider);
  assert.ok(rows.length);
  const result = await assistant.chat({ provider, model: rows[0].id, messages: [{ role: 'user', content: 'Draft a follow-up' }] });
  assert.match(result.text, /Sample response/);
  const payload = JSON.parse(calls[1][1].body);
  assert.equal(payload.tools, undefined);
  assert.match(calls[1][1].body, /No workspace data is attached/);
  assert.equal(db.prepare('SELECT count(*) n FROM sms_messages').get().n, 0);
});
test('assistant rejects unverified providers and model URL injection', async () => {
  const integrations = createIntegrationService({ fetchFn: createIntegrationsQaProvider() });
  const assistant = createAssistantService({ integrations });
  await assert.rejects(assistant.models('anthropic'), /Verify/);
  integrations.save('gemini', fixture); await integrations.verify('gemini');
  await assert.rejects(assistant.chat({ provider: 'gemini', model: '../../foo', messages: [{ role: 'user', content: 'Hello' }] }), /model/);
});
test('new writes are protected by workspace permissions', () => {
  assert.equal(workspaceRoutePermission('PUT', '/integrations/twilio'), 'manageConnections');
  assert.equal(workspaceRoutePermission('POST', '/sms/messages'), 'outreach');
  assert.equal(workspaceRoutePermission('POST', '/assistant/chat'), 'outreach');
});
