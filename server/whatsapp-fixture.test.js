import test from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsAppQaProvider, WHATSAPP_QA_ACCOUNT, WHATSAPP_QA_NUMBERS } from '../scripts/whatsapp-qa-provider.mjs';

const url = `https://graph.facebook.com/${WHATSAPP_QA_ACCOUNT.apiVersion}/${WHATSAPP_QA_ACCOUNT.phoneNumberId}/messages`;
const post = (to = WHATSAPP_QA_NUMBERS[0]) => ({ method: 'POST', headers: { Authorization: `Bearer ${WHATSAPP_QA_ACCOUNT.accessToken}` }, body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: 'website_design', components: [{ type: 'body', parameters: [{ type: 'text', text: 'Exact reviewed text' }] }] } }) });

test('QA provider accepts only fictional destinations and exposes no credential in its outbox', async () => {
  const provider = createWhatsAppQaProvider({ startTime: 12345 });
  const result = await provider.fetchFn(url, post());
  assert.equal(result.status, 200);
  assert.equal((await result.json()).messages[0].id, 'wamid.qa_1');
  const rows = provider.outbox();
  assert.equal(rows[0].delivered, false);
  assert.equal(rows[0].attemptedAt, 12345);
  assert.deepEqual(rows[0].payload, JSON.parse(post().body));
  assert.ok(!JSON.stringify(rows).includes(WHATSAPP_QA_ACCOUNT.accessToken));
  rows[0].payload.to = 'mutated';
  assert.equal(provider.outbox()[0].payload.to, WHATSAPP_QA_NUMBERS[0]);
  assert.equal((await provider.fetchFn(url, post('14165550999'))).status, 400);
  assert.equal(provider.outbox().length, 1);
});

test('QA provider rejects non-Meta hosts and real credentials without network fallback', async () => {
  const provider = createWhatsAppQaProvider();
  await assert.rejects(provider.fetchFn('https://external.invalid/messages', post()), /No external request was made/);
  await assert.rejects(provider.fetchFn(url, { ...post(), headers: { Authorization: 'Bearer real-looking-token' } }), /No external request was made/);
  assert.deepEqual(provider.outbox(), []);
});

test('QA clock and known/ambiguous failure controls never imply delivered messages', async () => {
  const provider = createWhatsAppQaProvider({ startTime: 1000 });
  assert.equal(provider.advance(120000), 121000);
  assert.throws(() => provider.advance(-1), /simulated clock/);
  assert.throws(() => provider.advance(604800001), /simulated clock/);
  assert.throws(() => provider.setOutcome('14165550999', 'accepted'), /fictional QA/);
  provider.setOutcome(WHATSAPP_QA_NUMBERS[0], 'failed');
  assert.equal((await provider.fetchFn(url, post())).status, 400);
  provider.setOutcome(WHATSAPP_QA_NUMBERS[0], 'unknown');
  await assert.rejects(provider.fetchFn(url, post()), /No message was delivered/);
  assert.deepEqual(provider.outbox().map(row => row.outcome), ['failed', 'unknown']);
  assert.ok(provider.outbox().every(row => row.simulated && !row.delivered));
});
