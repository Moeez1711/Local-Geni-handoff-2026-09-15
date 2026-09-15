import test from 'node:test';
import assert from 'node:assert/strict';
import { batchContext, batchIds, batchNumber, batchNumberSuppressed, batchPreflightError, batchSnapshotKey, hasRecordedWhatsAppMessage, makeBatchRecipients, unsupportedBatchVariables } from './whatsappBatch.js';
import { waLink } from './outreach.js';

const lead = (id, extra = {}) => ({ id, lead: { place_id: id, name: `Business ${id}`, category: 'Dentist', phone_e164: '+14165550123', site_status: 'none', ...extra }, preview: {}, activity: [] });

test('batch selection preserves order, deduplicates IDs, and rejects an empty or oversized batch', () => {
  assert.deepEqual(batchIds(['one', 'two', 'one']), ['one', 'two']);
  assert.equal(batchIds(Array.from({ length: 25 }, (_, i) => String(i))).length, 25);
  assert.throws(() => batchIds([]), /Select between 1 and 25/);
  assert.throws(() => batchIds(Array.from({ length: 26 }, (_, i) => String(i))), /Select between 1 and 25/);
});

test('only usable international numbers become WhatsApp chat destinations', () => {
  assert.equal(batchNumber({ whatsapp: '+44 (7700) 900-123', phone_e164: '+14165550123' }), '447700900123');
  assert.equal(batchNumber({ whatsapp: 'https://evil.test', phone_e164: '+14165550123' }), '14165550123');
  for (const value of ['123', '0123456789', '+14165550123 ext 9', '+1234567890123456', 'javascript:123456789']) assert.equal(batchNumber({ whatsapp: value }), '');
});

test('batch defaults exclude missing and duplicate phone numbers without claiming WhatsApp verification', () => {
  const first = lead('one'); const second = lead('two'); const missing = lead('three', { phone_e164: null });
  const published = lead('four', { whatsapp: '+447700900123', whatsapp_source: 'website' });
  const rows = makeBatchRecipients([first, second, missing, published], 'Hello {name}', {});
  assert.deepEqual(rows.map(row => row.included), [true, false, false, true]);
  assert.equal(rows[1].duplicateOf, 'Business one');
  assert.equal(rows[0].publishedNumber, false);
  assert.equal(rows[3].publishedNumber, true);
  assert.ok(rows.every(row => row.reviewed === false && row.openedMessage === null && row.sentMessage === null));
});

test('shared templates preserve exact business names and personal details without recursively expanding data', () => {
  const entry = lead('one', { name: 'Café García–López {signoff}', category: 'Dentist' });
  entry.preview = { contactName: 'José', publicUrl: 'https://studio.agency/design/oak?from=asif&view=mobile', improvements: ['Keep {booking} clear.'] };
  const [row] = makeBatchRecipients([entry], 'Hi {contactName},\n{name}\n{previewUrl}\n{specificImprovement}\n{signoff}', { myName: 'Asif' });
  assert.equal(row.message, 'Hi José,\nCafé García–López {signoff}\nhttps://studio.agency/design/oak?from=asif&view=mobile\nKeep {booking} clear.\nAsif');
  assert.deepEqual(unsupportedBatchVariables('Hi {name}, {booking}, {booking}'), ['{booking}']);
  const opened = new URL(waLink(row.number, row.message));
  assert.equal(opened.searchParams.get('text'), row.message);
});

test('only an approved public URL populates the design field; legacy designUrl never becomes a prospect link', () => {
  for (const publicUrl of ['', 'http://studio.agency/oak', 'https://localhost/oak', 'https://example.com/oak', 'https://127.0.0.1/oak']) {
    assert.equal(batchContext({ publicUrl, designUrl: 'https://studio.agency/old-design' }).previewUrl, '');
  }
  const [row] = makeBatchRecipients([lead('one')], 'See my idea: {previewUrl}', {});
  assert.equal(row.missingDesignLink, true);
  assert.doesNotMatch(row.message, /https?:/);
});

test('saved pitches use each business web presence and sent dedupe is channel-specific and exact', () => {
  const [row] = makeBatchRecipients([lead('one')], '', { myName: 'Asif' }, true);
  assert.match(row.message, /don't have a website yet/);
  assert.match(row.message, /Asif$/);
  const exact = ' Hello José\nA design idea. ';
  row.message = exact;
  row.activity = [{ kind: 'draft_opened', channel: 'whatsapp', message: exact }, { kind: 'sent', channel: 'email', message: exact }];
  assert.equal(hasRecordedWhatsAppMessage(row), false);
  row.activity.push({ kind: 'sent', channel: 'whatsapp', message: exact });
  assert.equal(hasRecordedWhatsAppMessage(row), true);
  assert.equal(hasRecordedWhatsAppMessage(row, exact.trim()), false);
  assert.notEqual(batchSnapshotKey(row.id, row.number, exact), batchSnapshotKey(row.id, row.number, exact.trim()));
  assert.notEqual(batchSnapshotKey(row.id, row.number, exact), batchSnapshotKey(row.id, '447700900123', exact));
});

test('not-interested and lost opportunities stay excluded from the default batch', () => {
  const notInterested = lead('one', { lead_status: 'not_interested' });
  const lost = { ...lead('two', { phone_e164: '+447700900123' }), preview: { stage: 'lost' } };
  const rows = makeBatchRecipients([notInterested, lost], 'Hi {name}', {});
  assert.ok(rows.every(row => !row.included));
  assert.match(rows[0].restriction, /not interested/);
  assert.match(rows[1].restriction, /lost/);
});

test('preflight blocks stale or removed recipients before a WhatsApp destination can open', () => {
  const original = lead('one');
  const [recipient] = makeBatchRecipients([original], 'Hi {name}', {});
  assert.equal(batchPreflightError(recipient, original), '');
  assert.match(batchPreflightError(recipient, null), /no longer available/);
  assert.match(batchPreflightError(recipient, lead('other')), /no longer available/);
  assert.match(batchPreflightError(recipient, lead('one', { deleted_at: 123 })), /Trash/);
  assert.match(batchPreflightError(recipient, lead('one', { lead_status: 'not_interested' })), /not interested/);
  assert.match(batchPreflightError(recipient, { ...original, preview: { stage: 'lost' } }), /lost/);
  assert.match(batchPreflightError(recipient, lead('one', { phone_e164: '+447700900123' })), /phone number changed/);
  assert.match(batchPreflightError(recipient, lead('one', { phone_e164: null })), /phone number changed/);
  assert.match(batchPreflightError(recipient, lead('one', { name: 'Updated business name' })), /business name changed/);
  assert.match(batchPreflightError(recipient, { ...original, activity: [{ kind: 'sent', channel: 'whatsapp', message: recipient.message }] }), /already recorded as sent/);
  assert.equal(recipient.message, 'Hi Business one', 'preflight never rewrites the already reviewed message');
});

test('known WhatsApp withdrawal excludes a manual draft without treating missing API consent as an opt-out', () => {
  const original = lead('one');
  const [normal] = makeBatchRecipients([original], 'Hi {name}', {});
  assert.equal(normal.included, true);
  assert.equal(batchNumberSuppressed(normal.number, []), false);
  assert.equal(batchNumberSuppressed(normal.number, [{ number: '447700900123' }]), false);
  assert.equal(batchNumberSuppressed(normal.number, [{ number: normal.number }]), true);
  const suppressed = { ...original, whatsappSuppressed: true };
  const [blocked] = makeBatchRecipients([suppressed], 'Hi {name}', {});
  assert.equal(blocked.included, false);
  assert.match(batchPreflightError(normal, suppressed), /withdrawn WhatsApp permission/);
});
