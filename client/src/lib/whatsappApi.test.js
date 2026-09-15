import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingWhatsAppConsent, resolveWhatsAppParameter, whatsappApiRecipients, whatsappHasQueued, whatsappHasUnresolved, whatsappReviewKey, WA_API_STATUSES } from './whatsappApi.js';

const entry = (id = 'one', fields = {}) => ({ id, lead: { place_id: id, name: 'Café García & Sons', phone_e164: '+14165550123', category: 'Café', ...fields }, preview: { contactName: 'José', publicUrl: 'https://studio.agency/design/cafe?view=mobile', improvements: ['A clearer menu'] } });
const template = { parameters: [{ key: 'body.1', label: 'Business name' }, { key: 'body.2', label: 'Note' }] };

test('API personalization preserves literal names and custom text and pins the reviewed number', () => {
  const rows = whatsappApiRecipients([entry()], template, { 'body.1': { source: 'name' }, 'body.2': { source: 'custom', value: ' Hello José {name} ' } }, {}, { one: true });
  assert.deepEqual(rows, [{ placeId: 'one', number: '14165550123', parameters: { 'body.1': 'Café García & Sons', 'body.2': ' Hello José {name} ' } }]);
  assert.equal(resolveWhatsAppParameter({ source: 'signoff' }, entry(), { myName: 'Asif', myCompany: 'Local Geni' }), 'Asif, Local Geni');
});

test('API design values require a saved public link and dynamic buttons require the approved URL prefix', () => {
  const button = { parameters: [{ key: 'button.0', label: 'Design URL' }], buttons: [{ index: 0, url: 'https://studio.agency/design/{{1}}' }] };
  const bindings = { 'button.0': { source: 'previewUrl' } };
  assert.equal(whatsappApiRecipients([entry()], button, bindings, {}, { one: true })[0].parameters['button.0'], 'cafe?view=mobile');
  const wrong = { ...entry(), preview: { publicUrl: 'https://different.agency/design/cafe' } };
  assert.throws(() => whatsappApiRecipients([wrong], button, bindings, {}, { one: true }), /does not match/);
  for (const publicUrl of ['', 'https://localhost/design', 'http://studio.agency/design', 'https://example.com/design']) {
    const invalid = { ...entry(), preview: { publicUrl, designUrl: 'https://studio.agency/design/legacy' } };
    assert.equal(resolveWhatsAppParameter({ source: 'previewUrl' }, invalid), '');
    assert.throws(() => whatsappApiRecipients([invalid], button, bindings, {}, { one: true }), /fill Design URL/);
  }
});

test('API preparation fails the whole selection for duplicate, missing or restricted recipients', () => {
  const noFields = { parameters: [] };
  const prepare = rows => whatsappApiRecipients(rows, noFields, {}, {}, Object.fromEntries(rows.map(row => [row.id, true])));
  assert.throws(() => prepare([entry(), entry('two')]), /share one WhatsApp number/);
  assert.throws(() => prepare([entry('one', { phone_e164: null })]), /international phone/);
  assert.throws(() => prepare([entry('one', { lead_status: 'not_interested' })]), /not interested/);
  assert.throws(() => prepare([{ ...entry(), whatsappSuppressed: true }]), /withdrawn/);
  assert.throws(() => prepare([{ id: 'one', error: 'Unavailable' }]), /could not be loaded/);
  assert.deepEqual(whatsappApiRecipients([entry()], noFields, {}, {}, { one: false }), []);
});

test('API field bounds reject unresolved or multiline parameters without silently editing them', () => {
  const one = { parameters: [{ key: 'body.1', label: 'Greeting' }] };
  const prepare = value => whatsappApiRecipients([entry()], one, { 'body.1': { source: 'custom', value } }, {}, { one: true });
  for (const value of ['', '   ', '\n']) assert.throws(() => prepare(value), /fill Greeting/);
  for (const value of ['Hello\nJosé', 'Hello\tJosé', '{{name}}', 'Hello     José', 'x'.repeat(1025)]) assert.throws(() => prepare(value), /single-line text/);
  assert.equal(prepare('x'.repeat(1024))[0].parameters['body.1'].length, 1024);
});

test('permission belongs to the exact business and number and requires an explicit grant', () => {
  const current = entry(); const grant = { placeId: 'one', number: '+14165550123', optedIn: true };
  assert.equal(matchingWhatsAppConsent(current, [grant]), grant);
  for (const changed of [{ placeId: 'two' }, { number: '447700900123' }, { optedIn: false }, { optedIn: 1 }]) assert.equal(matchingWhatsAppConsent(current, [{ ...grant, ...changed }]), null);
  assert.equal(matchingWhatsAppConsent(current, []), null);
});

test('review confirmation is invalidated by destination, body, footer or button changes', () => {
  const message = { placeId: 'one', number: '14165550123', header: 'Hello', body: 'A design for José', footer: 'Reply to stop', buttons: [{ text: 'View', url: 'https://studio.agency/design/cafe' }], text: 'Exact canonical content' };
  const key = whatsappReviewKey(message, 0);
  for (const changed of [{ number: '447700900123' }, { body: message.body + ' ' }, { footer: 'Changed footer' }, { buttons: [{ ...message.buttons[0], url: 'https://studio.agency/design/new' }] }, { text: message.text + '\n' }]) assert.notEqual(whatsappReviewKey({ ...message, ...changed }, 0), key);
  assert.notEqual(whatsappReviewKey(message, 1), key);
});

test('queue controls distinguish accepted outcomes from queued and uncertain work', () => {
  assert.equal(whatsappHasQueued({ rows: [{ status: 'accepted' }, { status: 'unknown' }] }), false);
  assert.equal(whatsappHasUnresolved({ rows: [{ status: 'unknown' }] }), true);
  assert.equal(whatsappHasUnresolved({ rows: [{ status: 'accepted' }] }), false);
  assert.equal(whatsappHasQueued({ rows: [{ status: 'queued' }] }), true);
  assert.equal(WA_API_STATUSES.accepted, 'Accepted by Meta');
  assert.equal(WA_API_STATUSES.unknown, 'Outcome uncertain');
});
