import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.DB_PATH = ':memory:';
const { db } = await import('./db.js');
const { createIntegrationService } = await import('./integrations.js');
const { createSmsService } = await import('./sms.js');
const { createSmsBatchService } = await import('./smsBatches.js');
const { createIntegrationsQaProvider } = await import('../scripts/integrations-qa-provider.mjs');
const fixture = { accountSid: `AC${'a'.repeat(32)}`, authToken: 'QA_ONLY', fromNumber: '+14165550100' };
beforeEach(() => db.exec('DELETE FROM sms_batch_recipients; DELETE FROM sms_batches; DELETE FROM sms_messages; DELETE FROM sms_suppressions; DELETE FROM integration_connections; DELETE FROM businesses;'));
async function setup(fetchFn) {
  let time = 1800000000000, calls = 0;
  const now = () => time, mock = createIntegrationsQaProvider();
  const integrations = createIntegrationService({ fetchFn: mock });
  integrations.save('twilio', fixture); await integrations.verify('twilio');
  const sms = createSmsService({ integrations, now, fetchFn: async (...args) => { calls++; return (fetchFn || mock)(...args); } });
  const batches = createSmsBatchService({ sms, integrations, now });
  const preview = (recipients = ['+14165550123', '+14165550124']) => batches.preview({ provider: 'twilio', body: 'Fictional batch.', recipients });
  const input = recipients => ({ ...preview(recipients), requestId: crypto.randomUUID(), consent: true, confirmed: true });
  return { integrations, sms, batches, preview, input, now, advance: ms => { time += ms; }, calls: () => calls };
}
test('bulk preview normalizes, deduplicates and excludes blocked recipients without sending', async () => {
  const { sms, preview, calls, batches } = await setup();
  sms.suppress('+14165550124');
  const result = preview(['+1 (416) 555-0123', '+14165550123', '+14165550124']);
  assert.deepEqual(result.recipients, [{ number: '+14165550123' }]);
  assert.equal(result.duplicates, 1); assert.equal(result.excluded[0].reason, 'SMS blocked');
  assert.equal(calls(), 0);
  assert.throws(() => preview(['4165550123']), /international/);
  assert.throws(() => preview(Array(1001).fill('+14165550123')), /1,000/);
  assert.throws(() => batches.create({ ...result, requestId: crypto.randomUUID(), confirmed: true }), /permission/);
});
test('bulk creation and submission are idempotent and use the reviewed message', async () => {
  const { batches, input, calls } = await setup(), request = input();
  const first = batches.create(request);
  assert.equal(calls(), 0);
  assert.equal(batches.create(request).id, first.id);
  assert.throws(() => batches.create({ ...request, body: 'Changed' }), /different batch/);
  await batches.tick(); await batches.tick(); await batches.tick();
  assert.equal(calls(), 2);
  const result = batches.detail(first.id);
  assert.equal(result.status, 'completed'); assert.equal(result.counts.queued, 2);
  assert.deepEqual(db.prepare('SELECT body FROM sms_messages').all().map(r => r.body), ['Fictional batch.', 'Fictional batch.']);
});
test('paused and cancelled recipients never reach the provider', async () => {
  const { batches, input, calls } = await setup(), first = batches.create(input());
  batches.control(first.id, 'pause'); await batches.tick(); assert.equal(calls(), 0);
  batches.control(first.id, 'resume'); await batches.tick(); assert.equal(calls(), 1);
  batches.control(first.id, 'cancel'); await batches.tick();
  assert.equal(calls(), 1); assert.equal(batches.detail(first.id).counts.cancelled, 1);
});
test('cancelling during submission retains the in-flight outcome and cancels unsent recipients', async () => {
  let release;
  const { batches, input, calls } = await setup(() => new Promise(resolve => { release = resolve; }));
  const first = batches.create(input()), pending = batches.tick();
  batches.control(first.id, 'cancel');
  release(new Response(JSON.stringify({ sid: `SM${'a'.repeat(32)}`, status: 'queued' })));
  await pending;
  assert.equal(calls(), 1);
  assert.equal(batches.detail(first.id).counts.queued, 1); assert.equal(batches.detail(first.id).counts.cancelled, 1);
});
test('changing sender after review or during a queue blocks further submissions', async () => {
  const { batches, input, integrations, calls } = await setup(), request = input(), first = batches.create(request);
  integrations.save('twilio', { ...fixture, fromNumber: '+14165550200' }); await integrations.verify('twilio');
  assert.throws(() => batches.create({ ...request, requestId: crypto.randomUUID() }), /sender changed/);
  await batches.tick(); assert.equal(batches.detail(first.id).status, 'paused');
  assert.throws(() => batches.control(first.id, 'resume'), /sender changed/); assert.equal(calls(), 0);
});
test('ambiguous submissions pause remaining recipients and never retry the ambiguous message', async () => {
  const { batches, input, calls } = await setup(async () => { throw new Error('network ended'); }), first = batches.create(input());
  await batches.tick(); await batches.tick();
  assert.equal(calls(), 1); assert.equal(batches.detail(first.id).counts.unknown, 1);
  batches.control(first.id, 'resume'); await batches.tick();
  assert.equal(calls(), 2); assert.equal(batches.detail(first.id).counts.unknown, 2);
});
test('bulk respects the shared ten-submission per minute limit', async () => {
  const { batches, input, calls, advance } = await setup();
  const first = batches.create(input(Array.from({ length: 11 }, (_, n) => `+14165550${String(100 + n).padStart(3, '0')}`)));
  for (let n = 0; n < 12; n++) await batches.tick();
  assert.equal(calls(), 10); assert.equal(batches.detail(first.id).counts.pending, 1);
  advance(60001); await batches.tick(); assert.equal(calls(), 11);
});
test('CRM changes after review skip unsent recipients', async () => {
  const { batches, input, calls } = await setup();
  db.prepare('INSERT INTO businesses(place_id,name,phone_e164,first_seen,last_seen) VALUES(?,?,?,?,?)').run('qa-bulk-lead', 'Fictional QA business', '+14165550123', 1, 1);
  const first = batches.create(input([{ number: '+14165550123', placeId: 'qa-bulk-lead' }]));
  db.prepare('UPDATE businesses SET phone_e164=? WHERE place_id=?').run('+14165550999', 'qa-bulk-lead');
  await batches.tick(); assert.equal(calls(), 0); assert.equal(batches.detail(first.id).counts.skipped, 1);
});
test('restart pauses a batch and reconciles an existing submission before eligibility checks', async () => {
  const { batches, input, sms, integrations, now, calls } = await setup(), request = input(), first = batches.create(request);
  await sms.send({ provider: request.provider, connectionRevision: request.connectionRevision, requestId: `${first.id}-0`, recipient: request.recipients[0].number, body: request.body, consent: true, confirmed: true });
  sms.suppress(request.recipients[0].number);
  const restored = createSmsBatchService({ sms, integrations, now, recoverInterrupted: true });
  assert.equal(restored.detail(first.id).status, 'paused'); await restored.tick(); assert.equal(calls(), 1);
  restored.control(first.id, 'resume'); await restored.tick();
  assert.equal(calls(), 1); assert.equal(restored.detail(first.id).counts.queued, 1);
});
