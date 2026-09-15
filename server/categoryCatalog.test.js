import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
process.env.DB_PATH = ':memory:';
const { createCategoryCatalog, CATEGORY_SCOPE, categoryLocale } = await import('./categoryCatalog.js');
const { workspaceRoutePermission } = await import('./auth.js');
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const client = { clientId: 'fictional-client.apps.googleusercontent.com', clientSecret: 'fictional-secret' };
function fixture() {
  const database = new DatabaseSync(':memory:'), secrets = new Map(), requests = [];
  let time = 1000000000, responder = () => json({ categories: [{ name: 'gcid:cafe', displayName: 'Café' }] });
  let tokenResponder = init => json(init.body.get('grant_type') === 'authorization_code' ? { refresh_token: 'fictional-refresh-token', scope: CATEGORY_SCOPE } : { access_token: 'fictional-access-token' });
  const service = createCategoryCatalog({ database, now: () => time, vault: { get: key => secrets.get(key), set: (key, value) => secrets.set(key, value), delete: key => secrets.delete(key) },
    fetchFn: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith('/token')) return tokenResponder(init);
      return responder(url, init);
    } });
  const connect = async () => { service.configure(client); const flow = service.begin({ origin: 'http://127.0.0.1:4000', binding: 'owner-session' }); await service.complete({ ...flow, code: 'fictional-code', binding: 'owner-session' }); return flow; };
  return { service, requests, connect, secrets, database, advance: delta => { time += delta; }, respond: fn => { responder = fn; }, tokenRespond: fn => { tokenResponder = fn; } };
}

test('catalogue validates locales and assigns read vs administrative permissions', () => {
  assert.deepEqual(categoryLocale('ca', 'fr-ca'), { country: 'CA', language: 'fr-CA', key: 'CA:fr-CA' });
  for (const pair of [['XX', 'en'], ['US', 'bad language'], ['US', '']]) assert.throws(() => categoryLocale(...pair));
  for (const path of ['/api/categories/connection', '/api/categories/oauth/complete', '/api/categories/refresh', '/api/categories/automatic']) assert.equal(workspaceRoutePermission('POST', path), 'manageConnections');
  assert.equal(workspaceRoutePermission('GET', '/api/categories'), 'read');
  assert.equal(workspaceRoutePermission('POST', '/api/export/preview'), 'read');
});
test('OAuth binds state to initiator, requests consent scope, uses PKCE, expires and cannot replay', async () => {
  const f = fixture(); f.service.configure(client);
  const flow = f.service.begin({ origin: 'http://127.0.0.1:4000', binding: 'owner-session' }), url = new URL(flow.url);
  assert.equal(url.searchParams.get('scope'), CATEGORY_SCOPE); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  await assert.rejects(f.service.complete({ state: flow.state, code: 'code', binding: 'someone-else' }), /expired/);
  await f.service.complete({ state: flow.state, code: 'code', binding: 'owner-session' });
  const verifier = f.requests[0].init.body.get('code_verifier');
  assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(f.service.status().connected, true);
  assert.ok(!JSON.stringify(f.service.status()).includes('fictional-secret'));
  assert.ok(!JSON.stringify(f.service.status()).includes('fictional-refresh'));
  await assert.rejects(f.service.complete({ state: flow.state, code: 'code', binding: 'owner-session' }), /expired/);
  const expired = f.service.begin({ origin: 'http://127.0.0.1:4000', binding: 'owner-session' }); f.advance(11 * 60000);
  await assert.rejects(f.service.complete({ ...expired, code: 'code', binding: 'owner-session' }), /expired/);
  assert.throws(() => f.service.begin({ origin: 'https://evil.example.com', binding: 'owner-session' }), /local app/);
});
test('OAuth rejects missing offline grant or missing scope without saving credentials', async () => {
  for (const response of [{ scope: CATEGORY_SCOPE }, { refresh_token: 'fictional-refresh-token', scope: 'openid email' }]) {
    const f = fixture(); f.service.configure(client); f.tokenRespond(() => json(response));
    const flow = f.service.begin({ origin: 'http://127.0.0.1:4000', binding: 'owner-session' });
    await assert.rejects(f.service.complete({ ...flow, code: 'code', binding: 'owner-session' }), /Grant Business Profile access/);
    assert.equal(f.service.status().connected, false);
    assert.equal([...f.secrets.values()].some(value => value.refreshToken), false);
  }
});
test('empty or malformed provider catalogues never replace the last usable import', async () => {
  const f = fixture(); await f.connect(); await f.service.refresh({ country: 'US', language: 'en' });
  const previous = f.service.list('US', 'en');
  for (const response of [{ categories: [] }, { categories: [{ name: 'gcid:bad', displayName: '' }] }, { categories: 'invalid' }]) {
    f.respond(() => json(response));
    await assert.rejects(f.service.refresh({ country: 'US', language: 'en' }));
    assert.deepEqual(f.service.list('US', 'en'), previous);
  }
});
test('imports every page with required locale parameters and deduplicates IDs', async () => {
  const f = fixture(); await f.connect();
  f.respond(url => { const q = new URL(url).searchParams; assert.equal(q.get('pageSize'), '100'); assert.equal(q.get('view'), 'BASIC'); assert.equal(q.get('regionCode'), 'CA'); assert.equal(q.get('languageCode'), 'fr');
    return q.get('pageToken') ? json({ categories: [{ name: 'gcid:cafe', displayName: 'Café' }, { name: 'gcid:specialist', displayName: 'Spécialiste local' }] }) : json({ categories: [{ name: 'gcid:cafe', displayName: 'Café' }], nextPageToken: 'page2' }); });
  const result = await f.service.refresh({ country: 'CA', language: 'fr' });
  assert.equal(result.googleCount, 2); assert.equal(result.status.locales[0].count, 2);
  assert.equal(f.service.resolve('gbp:gcid:specialist', 'CA', 'fr').query, 'Spécialiste local');
  assert.ok(f.requests.filter(row => row.url.includes('/v1/categories')).every(row => row.init.headers.Authorization === 'Bearer fictional-access-token'));
});
test('failed or cyclic pagination preserves previous snapshot and hides provider secrets', async () => {
  const f = fixture(); await f.connect(); await f.service.refresh({ country: 'US', language: 'en' });
  const previous = f.service.list('US', 'en');
  f.respond(url => new URL(url).searchParams.get('pageToken') ? json({ error: 'fictional-secret: private detail' }, 403) : json({ categories: [{ name: 'gcid:new', displayName: 'New category' }], nextPageToken: 'next' }));
  await assert.rejects(f.service.refresh({ country: 'US', language: 'en' }), /approved Google project/);
  assert.deepEqual(f.service.list('US', 'en'), previous);
  assert.ok(!JSON.stringify(f.service.status()).includes('private detail'));
  f.respond(() => json({ categories: [{ name: 'gcid:new', displayName: 'New category' }], nextPageToken: 'same' }));
  await assert.rejects(f.service.refresh({ country: 'US', language: 'en' }), /incomplete/);
  assert.deepEqual(f.service.list('US', 'en'), previous);
});
test('disconnect and revoked initiator prevent in-flight credentials or catalogue writes', async () => {
  const f = fixture(); await f.connect();
  f.respond(() => { f.service.disconnect(); return json({ categories: [{ name: 'gcid:new', displayName: 'New category' }] }); });
  await assert.rejects(f.service.refresh({ country: 'US', language: 'en' }), /connection changed/);
  assert.equal(f.service.list('US', 'en').googleCount, 0); assert.equal(f.service.status().connected, false);
  f.service.configure(client); const flow = f.service.begin({ origin: 'http://127.0.0.1:4000', binding: 'owner-session' });
  await assert.rejects(f.service.complete({ ...flow, code: 'code', binding: 'owner-session', assertCurrent() { throw new Error('Session revoked'); } }), /Session revoked/);
  assert.equal(f.service.status().connected, false);
});
test('automatic refresh touches only saved stale locales, keeps cache after disconnect and stays off by default', async () => {
  const f = fixture(); await f.connect(); await f.service.refresh({ country: 'US', language: 'en' });
  let before = f.requests.length; f.advance(31 * 86400000); await f.service.refreshDue(); assert.equal(f.requests.length, before);
  f.service.setAuto(true); await f.service.refreshDue(); assert.equal(f.requests.length, before + 2);
  before = f.requests.length; await f.service.refreshDue(); assert.equal(f.requests.length, before);
  f.service.disconnect(); assert.equal(f.service.status().autoRefresh, false); assert.equal(f.service.list('US', 'en').googleCount, 1);
});
