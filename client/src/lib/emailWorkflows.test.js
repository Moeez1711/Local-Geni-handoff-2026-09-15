import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignPayload, campaignReviewKey, groupInboxThreads, validateCampaign } from './emailWorkflows.js';
import { emailSignature } from './email.js';

const valid = () => ({ name: 'Homepage outreach', accountId: 'one', timezone: 'America/Toronto', sendWindow: { start: '09:00', end: '17:00', days: [1, 2, 3] }, recipients: [{ placeId: 'a', to: 'owner@example.com' }], steps: [{ subject: 'Homepage idea', text: 'An exact message.', delayHours: 0 }] });
test('sequence validation rejects duplicate recipients and header injection before review', () => {
  assert.equal(validateCampaign(valid()), '');
  const duplicate = valid(); duplicate.recipients.push({ placeId: 'b', to: 'OWNER@example.com' });
  assert.match(validateCampaign(duplicate), /same email/);
  const injection = valid(); injection.steps[0].subject = 'Hi\r\nBcc: anyone@example.com';
  assert.match(validateCampaign(injection), /one line/);
});
test('sequence validation rejects invalid time zones and overnight or empty windows', () => {
  const draft = valid(); draft.timezone = 'Invalid/Zone'; assert.match(validateCampaign(draft), /time zone/);
  draft.timezone = 'UTC'; draft.sendWindow.start = '22:00'; assert.match(validateCampaign(draft), /end later/);
  draft.sendWindow.start = '09:00'; draft.sendWindow.days = []; assert.match(validateCampaign(draft), /sending day/);
  draft.sendWindow.days = [7]; assert.equal(validateCampaign(draft), '', 'Sunday follows the server contract: ISO weekday 7');
  draft.sendWindow.days = [0]; assert.match(validateCampaign(draft), /sending day/);
});
test('sequence payload preserves exact authored text and strips only display metadata', () => {
  const draft = valid(); draft.steps[0].text = '  Hi team,\n\nA homepage idea.  '; draft.recipients[0].name = 'Private display label';
  const payload = campaignPayload(draft);
  assert.equal(payload.steps[0].text, draft.steps[0].text); assert.equal(payload.recipients[0].name, undefined);
  assert.notEqual(campaignReviewKey({ ...payload.steps[0], to: 'owner@example.com' }, 0), campaignReviewKey({ ...payload.steps[0], text: 'Changed', to: 'owner@example.com' }, 0));
});
test('inbox threads keep accounts isolated and order incoming messages without mutating rows', () => {
  const rows = [{ id: 'b', accountId: 'two', placeId: 'lead', fromEmail: 'owner@example.com', receivedAt: 2 }, { id: 'a', accountId: 'one', placeId: 'lead', receivedAt: 1 }, { id: 'c', accountId: 'one', placeId: 'lead', receivedAt: 3 }];
  const threads = groupInboxThreads(rows);
  assert.equal(threads.length, 2); assert.equal(threads[0].accountId, 'one'); assert.deepEqual(threads[0].messages.map((row) => row.id), ['a', 'c']);
  assert.deepEqual(rows.map((row) => row.id), ['b', 'a', 'c']);
});
test('send reconciliation distinguishes accounts and reply threads while keeping the legacy sender stable', () => {
  const message = { to: 'owner@example.com', fromEmail: 'sender@example.com', subject: 'Re: Homepage', text: 'Thanks.' };
  assert.equal(emailSignature(message), emailSignature({ ...message, accountId: 'default', inReplyTo: null }));
  assert.notEqual(emailSignature(message), emailSignature({ ...message, accountId: 'another' }));
  assert.notEqual(emailSignature({ ...message, inReplyTo: '<first@example.com>' }), emailSignature({ ...message, inReplyTo: '<second@example.com>' }));
});
