import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
const { db } = await import('./db.js');
const project = await import('./previewRepo.js');
const { trashLeads } = await import('./repo.js');
const { makeBatchRecipients, batchSnapshotKey, hasRecordedWhatsAppMessage } = await import('../client/src/lib/whatsappBatch.js');
const { waLink } = await import('../client/src/lib/outreach.js');
let id = 0;
const lead = () => { const value = `whatsapp-integration-${++id}`; db.prepare("INSERT INTO businesses(place_id,name,category,phone_e164,first_seen,last_seen) VALUES(?,?,'Dentist','+14165550123',1,1)").run(value, 'Café & Dental'); return value; };
const detail = (placeId) => ({ id: placeId, ...project.getPreview(placeId) });

test('batch template, encoded WhatsApp URL and draft activity preserve the same message without marking contact', () => {
  const placeId = lead(); project.savePreview(placeId, { publicUrl: 'https://studio.agency/design/dental?view=mobile&from=asif', contactName: 'José', stage: 'ready' });
  const [row] = makeBatchRecipients([detail(placeId)], 'Hi {contactName},\n{name}\n{previewUrl}\n{signoff}', { myName: 'Asif' });
  assert.equal(row.reviewed, false); assert.equal(row.sentMessage, null);
  const destination = new URL(waLink(row.number, row.message));
  assert.equal(destination.hostname, 'wa.me'); assert.equal(destination.pathname, '/14165550123'); assert.equal(destination.searchParams.get('text'), row.message);
  const before = project.getPreview(placeId); assert.equal(before.activity.length, 0);
  const opened = project.recordActivity(placeId, { kind: 'draft_opened', channel: 'whatsapp', message: destination.searchParams.get('text'), idempotencyKey: 'wa-open:integration-message' });
  assert.equal(opened.activity[0].message, row.message); assert.equal(opened.lead.last_contacted_at, null); assert.equal(opened.lead.lead_status, 'not_contacted');
  assert.equal(opened.preview.stage, 'ready'); assert.equal(hasRecordedWhatsAppMessage({ ...row, activity: opened.activity }), false);
});

test('manual sent confirmation is idempotent and separate from opening or retrying the draft record', () => {
  const placeId = lead(); const message = '  A personal message for José.\n';
  const draft = { kind: 'draft_opened', channel: 'whatsapp', message, idempotencyKey: 'wa-open:manual-message' };
  project.recordActivity(placeId, draft); project.recordActivity(placeId, draft);
  assert.equal(project.getPreview(placeId).activity.length, 1); assert.equal(project.getPreview(placeId).lead.last_contacted_at, null);
  const sent = { ...draft, kind: 'sent', idempotencyKey: 'wa-sent:manual-message' };
  const first = project.recordActivity(placeId, sent); const second = project.recordActivity(placeId, sent);
  assert.equal(second.activity.length, 2); assert.equal(second.lead.last_contacted_at, first.lead.last_contacted_at);
  assert.equal(second.lead.lead_status, 'contacted'); assert.equal(second.preview.stage, 'shared');
  assert.ok(hasRecordedWhatsAppMessage({ message, activity: second.activity }));
  assert.throws(() => project.recordActivity(placeId, { ...sent, message: message.trim() }), (error) => error.status === 409);
  assert.notEqual(batchSnapshotKey(placeId, '14165550123', message), batchSnapshotKey(placeId, '14165550124', message));
});

test('deleted businesses cannot prepare new batch details or record draft/sent activity from a stale batch', () => {
  const placeId = lead(); const loaded = detail(placeId); assert.ok(loaded.lead); trashLeads([placeId]);
  assert.throws(() => detail(placeId), (error) => error.status === 404);
  for (const kind of ['draft_opened', 'sent']) assert.throws(() => project.recordActivity(placeId, { kind, channel: 'whatsapp', message: 'Stale message', idempotencyKey: `wa-${kind}:stale` }), (error) => error.status === 404);
  assert.equal(db.prepare('SELECT count(*) n FROM preview_activity WHERE place_id=?').get(placeId).n, 0);
  assert.equal(db.prepare('SELECT last_contacted_at FROM businesses WHERE place_id=?').get(placeId).last_contacted_at, null);
});

test('duplicate phone numbers are excluded by default and legacy private design URLs never enter batch messages', () => {
  const first = lead(), second = lead();
  project.savePreview(first, { designUrl: 'https://designer.agency/private-file' });
  const rows = makeBatchRecipients([detail(first), detail(second)], '{name}: {previewUrl}', {});
  assert.equal(rows[0].included, true); assert.equal(rows[1].included, false); assert.ok(rows[1].duplicateOf);
  assert.ok(rows.every((row) => row.missingDesignLink)); assert.ok(rows.every((row) => !row.message.includes('designer.agency')));
});

test.after(() => db.close());
