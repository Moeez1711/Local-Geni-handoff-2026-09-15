import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
const { db } = await import('./db.js');
const { listService: lists, listFilters } = await import('./lists.js');
const { workspaceRoutePermission } = await import('./auth.js');
const insert = db.prepare('INSERT INTO businesses(place_id,name,emails,score,tier,lead_status,first_seen,last_seen) VALUES(?,?,?,?,?,?,1,1)');
test.beforeEach(() => {
  db.exec('DELETE FROM crm_list_members; DELETE FROM crm_lists; DELETE FROM businesses;');
  insert.run('one', 'One', '["owner@example.com"]', 80, 'hot', 'not_contacted');
  insert.run('two', 'Two', '["OWNER@example.com"]', 40, 'potential', 'not_contacted');
  insert.run('three', 'Three', '[]', 20, 'low', 'not_interested');
});
const create = (patch = {}) => lists.save({ name: 'Prospects', kind: 'static', memberIds: ['one', 'two', 'three'], requestKey: 'creation-one', ...patch });
test('static lists retain membership across Trash and restoration; an empty list never expands to all leads', () => {
  const list = create();
  assert.equal(lists.members(list.id).total, 3);
  db.prepare('UPDATE businesses SET deleted_at=10 WHERE place_id=?').run('one');
  assert.equal(lists.members(list.id).total, 2);
  assert.ok(lists.get(list.id).memberIds.includes('one'));
  db.prepare('UPDATE businesses SET deleted_at=NULL WHERE place_id=?').run('one');
  assert.equal(lists.members(list.id).total, 3);
  const empty = create({ memberIds: [], requestKey: 'empty' });
  assert.equal(lists.members(empty.id).total, 0);
});
test('segments update from current records and revalidate selected recipients', () => {
  const list = create({ kind: 'segment', filters: { minScore: 70 } });
  assert.equal(lists.members(list.id).total, 1);
  db.prepare('UPDATE businesses SET score=90 WHERE place_id=?').run('two');
  assert.equal(lists.members(list.id).total, 2);
  db.prepare('UPDATE businesses SET score=10 WHERE place_id=?').run('one');
  assert.throws(() => lists.recipients(list.id, { channel: 'email', ids: ['one'] }), /left this list/);
  assert.throws(() => listFilters({ trash: true }), /unsupported/);
  assert.throws(() => listFilters({ minRating: 6 }), /valid minimum/);
});
test('creation retries do not duplicate lists and stale writes cannot overwrite them', () => {
  const original = create();
  assert.equal(create().id, original.id);
  assert.throws(() => create({ name: 'Changed request' }), /different details/);
  const next = lists.save({ ...original, name: 'Renamed' }, original.id);
  assert.equal(next.version, original.version + 1);
  assert.throws(() => lists.save({ ...original, name: 'Stale' }, original.id), /changed/);
});
test('outreach selections exclude duplicates, missing addresses, and not-interested leads', () => {
  const list = create();
  const result = lists.recipients(list.id, { channel: 'email', ids: ['one', 'two', 'three'] });
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.excluded.map(row => row.reason).sort(), ['Duplicate recipient', 'Not interested']);
  assert.throws(() => lists.recipients(list.id, { channel: 'email', ids: [] }), /at least one/);
  assert.throws(() => lists.recipients(list.id, { channel: 'email', ids: Array.from({ length: 26 }, (_, i) => String(i)) }), /up to 25/);
});
test('archiving preserves members and blocks outreach until restored', () => {
  const list = create();
  const archived = lists.archive(list.id, { version: list.version });
  assert.equal(lists.members(list.id).total, 0);
  assert.throws(() => lists.recipients(list.id, { channel: 'email', ids: ['one'] }), /Restore/);
  lists.archive(list.id, { version: archived.version }, true);
  assert.equal(lists.members(list.id).total, 3);
});
test('list editing and campaign handoffs use their corresponding role permissions', () => {
  assert.equal(workspaceRoutePermission('POST', '/api/lists'), 'editLeads');
  assert.equal(workspaceRoutePermission('PUT', '/api/lists/one'), 'editLeads');
  assert.equal(workspaceRoutePermission('POST', '/api/lists/one/recipients'), 'outreach');
  assert.equal(workspaceRoutePermission('GET', '/api/lists/one'), 'read');
});
