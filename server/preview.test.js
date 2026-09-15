import test from 'node:test';
import assert from 'node:assert/strict';

// Set before importing data access: tests never open the user's saved leads.
process.env.DB_PATH = ':memory:';
const { db } = await import('./db.js');
const p = await import('./previewRepo.js');
const { trashLeads } = await import('./repo.js');
const routes = await import('./routes/previews.js');
let nextId = 0;
function lead(name = 'A & B Studio') {
  const id = `test-${++nextId}`;
  db.prepare(`INSERT INTO businesses (place_id,name,category,website,first_seen,last_seen,notes,emails)
    VALUES (?,?,'Dentist','https://example.com',1,1,'PRIVATE LEAD NOTE','["private-owner@example.com"]')`).run(id, name);
  return id;
}
const fails = (fn, status) => assert.throws(fn, (error) => error.status === status);

test('reading a lead never creates a project or marks it contacted', () => {
  const id = lead(); const detail = p.getPreview(id);
  assert.equal(detail.preview.exists, false); assert.equal(detail.preview.stage, 'shortlisted');
  assert.equal(detail.lead.last_contacted_at, null);
  assert.equal(db.prepare('SELECT count(*) n FROM lead_previews WHERE place_id=?').get(id).n, 0);
  fails(() => p.getPreview('missing'), 404);
});

test('an external public link alone can mark a project ready and is returned for outreach', () => {
  const id = lead();
  const result = p.savePreview(id, { publicUrl: ' https://designs.studio.com/business/homepage ', stage: 'ready', minutesSpent: 10.6, dealValue: 200.115 });
  assert.equal(result.preview.publicUrl, 'https://designs.studio.com/business/homepage');
  assert.equal(result.preview.designUrl, ''); assert.equal(result.preview.stage, 'ready');
  assert.equal(result.preview.minutesSpent, 11); assert.equal(result.preview.dealValue, 200.12);
  assert.equal(p.externalPublicUrl(result.preview), result.preview.publicUrl);
  assert.equal(p.listPreviews({ stage: 'ready' }).rows.find((r) => r.place_id === id).publicUrl, result.preview.publicUrl);
  assert.equal(result.lead.last_contacted_at, null);
});

test('project validation rejects unsafe URLs, image input, invalid amounts, and ready without an external link', () => {
  const id = lead();
  for (const body of [null, [], { stage: 'oops' }, { stage: 'ready' }, { improvements: ['a', 'b', 'c', 'd'] }, { minutesSpent: -1 }, { dealValue: '5' }, { title: '' }, { assets: {} }, { dataUrl: 'data:image/png;base64,abc' },
    ...['javascript:alert(1)', 'http://designs.studio.com', 'https://me:password@designs.studio.com', 'https://localhost/homepage', 'https://127.0.0.1/homepage', 'https://[::1]/homepage', 'https://printer.local/homepage', 'https://example.com/homepage', 'https://studio.test/homepage', 'https://localtest.me/homepage', 'https://designs.studio.com:8443/homepage', 'https://designs.studio.com/%0aInjected'].map((publicUrl) => ({ publicUrl }))]) fails(() => p.savePreview(id, body), 400);
  assert.equal(p.externalPublicUrl({ publicUrl: 'http://localhost:4000/p/old' }), '');
  assert.equal(p.externalPublicUrl({ designUrl: 'https://private-design-file.studio.com' }), '');
});

test('partial link edits preserve legacy assets, publication snapshots, notes and activity without exposing retired hosting fields', () => {
  const id = lead();
  const original = { title: 'Existing project', brief: 'Keep design brief', designUrl: 'https://designs.studio.com/original', assets: { afterDesktop: { id: 'legacy-asset', width: 1 } }, legacyPrivateValue: 'KEEP_LEGACY_DATA', ctaUrl: 'mailto:designer@studio.com' };
  db.prepare('INSERT INTO lead_previews(place_id,stage,draft_json,updated_at,share_token,published_at,snapshot_json) VALUES(?,?,?,?,?,?,?)')
    .run(id, 'designing', JSON.stringify(original), 1, 'legacy-local-token', 2, '{"legacy":"snapshot"}');
  db.prepare('INSERT INTO preview_assets(id,place_id,mime,bytes,created_at) VALUES(?,?,?,?,?)').run('legacy-asset', id, 'image/png', Buffer.from([1, 2, 3]), 1);
  p.recordActivity(id, { kind: 'draft_opened', channel: 'email', message: 'Keep exact history\n' });
  const result = p.savePreview(id, { publicUrl: 'https://designs.studio.com/approved', stage: 'ready' });
  const row = db.prepare('SELECT * FROM lead_previews WHERE place_id=?').get(id); const draft = JSON.parse(row.draft_json);
  assert.equal(draft.brief, original.brief); assert.equal(draft.designUrl, original.designUrl); assert.deepEqual(draft.assets, original.assets);
  assert.equal(draft.legacyPrivateValue, original.legacyPrivateValue); assert.equal(draft.ctaUrl, original.ctaUrl);
  assert.equal(row.share_token, 'legacy-local-token'); assert.equal(row.snapshot_json, '{"legacy":"snapshot"}'); assert.equal(row.published_at, 2);
  assert.deepEqual(Buffer.from(db.prepare('SELECT bytes FROM preview_assets WHERE id=?').get('legacy-asset').bytes), Buffer.from([1, 2, 3]));
  for (const field of ['assets', 'shareToken', 'sharePath', 'publishedAt', 'snapshot_json', 'ctaUrl', 'legacyPrivateValue']) assert.equal(result.preview[field], undefined);
  assert.ok(!JSON.stringify(result).includes('legacy-local-token')); assert.ok(!JSON.stringify(p.listPreviews().rows).includes('/api/previews/'));
  assert.equal(result.activity[0].message, 'Keep exact history\n');
});

test('legacy image data alone cannot satisfy a new ready transition', () => {
  const id = lead();
  db.prepare('INSERT INTO lead_previews(place_id,stage,draft_json,updated_at) VALUES(?,?,?,1)').run(id, 'designing', JSON.stringify({ assets: { afterDesktop: { id: 'old-image' } } }));
  fails(() => p.savePreview(id, { stage: 'ready' }), 400);
  assert.equal(JSON.parse(db.prepare('SELECT draft_json FROM lead_previews WHERE place_id=?').get(id).draft_json).assets.afterDesktop.id, 'old-image');
});

test('active routes contain only private link tracking and activity, with no upload, publishing, public rendering or export handlers', () => {
  const paths = routes.default.stack.filter((layer) => layer.route).map((layer) => `${Object.keys(layer.route.methods).join(',')} ${layer.route.path}`);
  assert.deepEqual(paths, ['get /', 'get /:placeId', 'put /:placeId', 'post /:placeId/activity']);
  assert.equal(routes.publicPreviewRouter, undefined);
  for (const name of ['putAsset', 'getAsset', 'removeAsset', 'publishPreview', 'revokePreview', 'getPublishedPreview', 'exportSnapshot']) assert.equal(p[name], undefined);
});

test('opening an outreach draft is distinct from an idempotent confirmed send', () => {
  const id = lead(); const message = '  A proposal for you.\n';
  const draft = p.recordActivity(id, { kind: 'draft_opened', channel: 'email', message });
  assert.equal(draft.lead.last_contacted_at, null); assert.equal(draft.lead.lead_status, 'not_contacted'); assert.equal(draft.activity[0].message, message);
  const body = { kind: 'sent', channel: 'email', message, idempotencyKey: 'send-once' }; const sent = p.recordActivity(id, body);
  assert.equal(sent.lead.lead_status, 'contacted'); assert.ok(sent.lead.last_contacted_at); assert.equal(sent.preview.stage, 'shared');
  assert.equal(p.recordActivity(id, body).activity.length, 2); fails(() => p.recordActivity(id, { ...body, message: 'Different message' }), 409);
});

test('replies, bookings and late sends never regress terminal pipeline decisions', () => {
  const id = lead();
  assert.equal(p.recordActivity(id, { kind: 'reply', channel: 'phone' }).preview.stage, 'replied');
  assert.equal(p.recordActivity(id, { kind: 'call_booked', channel: 'phone' }).preview.stage, 'call_booked');
  assert.equal(p.recordActivity(id, { kind: 'sent', channel: 'email' }).preview.stage, 'call_booked');
  for (const stage of ['won', 'lost']) { p.savePreview(id, { stage }); assert.equal(p.recordActivity(id, { kind: 'reply', channel: 'phone' }).preview.stage, stage); }
});

test('pipeline filters, category results and reply rates report confirmed outreach and won revenue', () => {
  const id = lead('Unique category result'); p.savePreview(id, { stage: 'won', minutesSpent: 25, dealValue: 499.95 });
  const result = p.listPreviews({ q: 'Unique category result', stage: 'won' }); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].place_id, id);
  assert.ok(result.summary.won >= 1); assert.ok(result.summary.revenue >= 499.95); assert.ok(result.byCategory.some((g) => g.category === 'Dentist' && g.won >= 1));
  const before = p.listPreviews().summary; const inbound = lead(); p.recordActivity(inbound, { kind: 'reply', channel: 'email' });
  assert.equal(p.listPreviews().summary.replied, before.replied + 1); assert.equal(p.listPreviews().summary.repliedToSent, before.repliedToSent);
  const outbound = lead(); p.recordActivity(outbound, { kind: 'sent', channel: 'email' }); p.recordActivity(outbound, { kind: 'reply', channel: 'email' });
  assert.equal(p.listPreviews().summary.repliedToSent, before.repliedToSent + 1);
});

test('trash hides projects and blocks mutations while restoring preserves the external link and history', () => {
  const id = lead('Trash project'); p.savePreview(id, { publicUrl: 'https://designs.studio.com/preserved', stage: 'ready' });
  p.recordActivity(id, { kind: 'sent', channel: 'whatsapp', message: 'An external homepage link.' }); trashLeads([id]);
  assert.ok(!p.listPreviews().rows.some((row) => row.place_id === id)); fails(() => p.getPreview(id), 404); fails(() => p.savePreview(id, { brief: 'Changed' }), 404);
  fails(() => p.recordActivity(id, { kind: 'sent', channel: 'email' }), 404); trashLeads([id], true);
  assert.equal(p.getPreview(id).preview.publicUrl, 'https://designs.studio.com/preserved'); assert.equal(p.getPreview(id).activity.length, 1);
});

test.after(() => db.close());
