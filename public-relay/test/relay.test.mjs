import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { handleRequest } from '../src/relay.js';

const ORIGIN = 'https://previews.studio.test';
const API_KEY = 'test-publishing-key-'.repeat(3);
const SIGNING_KEY = 'test-unsubscribe-key-'.repeat(3);
const PUBLICATION = 'a'.repeat(32);
const unsubscribeToken = (id = 'b'.repeat(43), key = SIGNING_KEY) => `${id}.${createHmac('sha256', key).update(`local-geni-unsubscribe:v1:${id}`).digest('base64url')}`;

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE publications(id TEXT PRIMARY KEY,title TEXT NOT NULL,object_key TEXT NOT NULL,published_at INTEGER NOT NULL,revoked_at INTEGER); CREATE TABLE unsubscribe_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,token_id TEXT NOT NULL UNIQUE,occurred_at INTEGER NOT NULL);');
  t.after(() => sqlite.close());
  const objects = new Map();
  const stats = { writes: 0, deleted: [] };
  const env = {
    PUBLISH_TOKEN: API_KEY, UNSUBSCRIBE_SIGNING_KEY: SIGNING_KEY,
    DB: { prepare(sql) {
      let args = [];
      return { bind(...values) { args = values; return this; }, async first() { return sqlite.prepare(sql).get(...args) || null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, async run() { stats.writes++; return sqlite.prepare(sql).run(...args); } };
    } },
    BUCKET: {
      async put(key, body) { objects.set(key, body); },
      async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; },
      async head(key) { return objects.has(key) ? {} : null; },
      async delete(key) { stats.deleted.push(key); objects.delete(key); },
    },
  };
  const request = (path, options = {}) => {
    const { auth = true, body, headers = {}, ...rest } = options;
    return handleRequest(new Request(`${ORIGIN}${path}`, { ...rest, headers: { ...(auth ? { authorization: `Bearer ${API_KEY}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }), env);
  };
  return { sqlite, objects, stats, env, request };
}

test('every administration endpoint requires the exact configured bearer token', async t => {
  const { request, env, stats } = fixture(t);
  for (const [path, method, body] of [['/api/health', 'GET'], ['/api/optouts', 'GET'], [`/api/previews/${PUBLICATION}`, 'PUT', { html: '<p>Removed feature</p>', title: 'Homepage' }], [`/api/previews/${PUBLICATION}`, 'DELETE']]) {
    for (const authorization of [undefined, API_KEY, `Bearer ${API_KEY}x`, `bearer ${API_KEY}`]) {
      const result = await request(path, { method, auth: false, body, headers: authorization ? { authorization } : {} });
      assert.equal(result.status, 401);
      assert.deepEqual(await result.json(), { error: 'Unauthorized' });
    }
  }
  assert.equal(stats.writes, 0);
  env.PUBLISH_TOKEN = '';
  assert.equal((await request('/api/health')).status, 401);
});

test('health verifies storage without exposing credentials or writing objects', async t => {
  const { request, objects, stats } = fixture(t);
  const response = await request('/api/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { service: 'local-geni-public-links', version: 1, ready: true });
  assert.equal(objects.size, 0);
  assert.equal(stats.writes, 0);
});

test('authenticated health proves the exact unsubscribe key with a fresh bound challenge', async t => {
  const { request, env, stats } = fixture(t);
  const challenge = 'c'.repeat(43);
  const response = await request(`/api/health?challenge=${challenge}`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.challenge, challenge);
  assert.equal(result.signingProof, createHmac('sha256', SIGNING_KEY).update(`local-geni-health:v1:${challenge}`).digest('base64url'));
  assert.ok(!JSON.stringify(result).includes(SIGNING_KEY));
  assert.equal(stats.writes, 0);
  assert.equal((await request('/api/health?challenge=short')).status, 400);
  assert.equal((await request(`/api/health?challenge=${challenge}`, { auth: false })).status, 401);
  env.UNSUBSCRIBE_SIGNING_KEY = '';
  assert.equal((await request('/api/health')).status, 503);
});

test('removed homepage APIs cannot publish or serve legacy content', async t => {
  const { request, sqlite, objects, stats } = fixture(t);
  sqlite.prepare('INSERT INTO publications VALUES(?,?,?,?,NULL)').run(PUBLICATION, 'Legacy', 'legacy.html', 1);
  objects.set('legacy.html', '<h1>Archived content</h1>');
  for (const method of ['PUT', 'DELETE', 'GET']) {
    assert.equal((await request(`/api/previews/${PUBLICATION}`, { method, ...(method === 'PUT' ? { body: { html: '<p>New</p>', title: 'New' } } : {}) })).status, 404);
  }
  for (const method of ['GET', 'HEAD']) {
    const response = await request(`/p/${PUBLICATION}`, { method, auth: false });
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /Archived content/);
  }
  assert.equal(stats.writes, 0);
  assert.equal(objects.size, 1, 'archived data remains untouched');
});

test('email preferences page uses private, accessible response headers', async t => {
  const { request } = fixture(t);
  const response = await request('/', { auth: false });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Email preferences/);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
});

test('storage failures return a useful message without internal details', async t => {
  const { request, env } = fixture(t);
  env.DB.prepare = () => { throw new Error('PRIVATE DATABASE ERROR'); };
  const response = await request('/api/health');
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /PRIVATE/);
});

test('unsubscribe GET is safe for email scanners and never records consent to unsubscribe', async t => {
  const { request, stats, sqlite } = fixture(t);
  const token = unsubscribeToken();
  for (let i = 0; i < 3; i++) {
    const response = await request(`/u/${token}`, { auth: false });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<form method="post"/);
  }
  assert.equal(stats.writes, 0);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM unsubscribe_events').get().count, 0);
  assert.equal((await request(`/api/optouts`, { auth: false })).status, 401);
});

test('unsubscribe requires a valid HMAC and explicit one-click POST, recorded exactly once', async t => {
  const { request, sqlite, env } = fixture(t);
  const token = unsubscribeToken();
  const post = (value, body = 'List-Unsubscribe=One-Click', headers = {}) => request(`/u/${value}`, { auth: false, method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
  for (const invalid of [unsubscribeToken('c'.repeat(43), 'wrong-key'), `${'c'.repeat(43)}.${token.split('.')[1]}`, `${token}x`, token.split('.')[0]]) {
    assert.equal((await post(invalid)).status, 404);
  }
  assert.equal((await post(token, '')).status, 400);
  assert.equal((await post(token, 'List-Unsubscribe=no')).status, 400);
  assert.equal((await post(token, '{}', { 'content-type': 'application/json' })).status, 415);
  assert.equal((await post(token, 'List-Unsubscribe=One-Click&x=' + 'x'.repeat(1001))).status, 413);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM unsubscribe_events').get().count, 0);
  assert.equal((await post(token)).status, 200);
  const first = sqlite.prepare('SELECT * FROM unsubscribe_events').get();
  assert.equal(first.token_id, token.split('.')[0]);
  assert.equal((await post(token)).status, 200);
  assert.deepEqual(sqlite.prepare('SELECT * FROM unsubscribe_events').get(), first);
  assert.equal(sqlite.prepare('SELECT count(*) AS count FROM unsubscribe_events').get().count, 1);
  env.UNSUBSCRIBE_SIGNING_KEY = '';
  assert.equal((await post(token)).status, 404);
});

test('opt-out feed pages by monotonically increasing cursor and exposes opaque IDs only', async t => {
  const { request, sqlite } = fixture(t);
  const insert = sqlite.prepare('INSERT INTO unsubscribe_events(token_id,occurred_at) VALUES(?,?)');
  for (let i = 1; i <= 503; i++) insert.run(String(i).padStart(43, 'x'), 1000 + i);
  const page1 = await (await request('/api/optouts?after=0')).json();
  assert.equal(page1.rows.length, 500);
  assert.equal(page1.nextCursor, 500);
  assert.equal(page1.hasMore, true);
  assert.deepEqual(Object.keys(page1.rows[0]).sort(), ['occurredAt', 'sequence', 'tokenId']);
  const page2 = await (await request(`/api/optouts?after=${page1.nextCursor}`)).json();
  assert.equal(page2.rows.length, 3);
  assert.equal(page2.rows[0].sequence, 501);
  assert.equal(page2.nextCursor, 503);
  assert.equal(page2.hasMore, false);
  const empty = await (await request('/api/optouts?after=503')).json();
  assert.deepEqual(empty, { rows: [], nextCursor: 503, hasMore: false });
  for (const invalid of ['-1', '1.2', 'NaN', 'Infinity', '9007199254740992']) assert.equal((await request(`/api/optouts?after=${invalid}`)).status, 400);
});
