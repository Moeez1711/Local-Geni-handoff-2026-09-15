import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { createPublicPublishingCore } from './publicPublishingService.js';

const ORIGIN = 'https://previews.example.com';
const API_TOKEN = 'a'.repeat(43);
const SIGNING_KEY = 'b'.repeat(43);
const emailError = (status, code, message) => Object.assign(new Error(message), { status, code });
const normalized = value => {
  if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw emailError(400, 'INVALID_EMAIL', 'Invalid email');
  return value.trim().toLowerCase();
};
const isCode = code => error => error.code === code;

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE secrets(name TEXT PRIMARY KEY,value TEXT); CREATE TABLE suppressions(email TEXT PRIMARY KEY,reason TEXT);');
  const requests = [];
  let time = 10000;
  const remote = { signingKey: SIGNING_KEY, fail: false, mutate: null, feed: { rows: [], nextCursor: 0, hasMore: false }, proof: null };
  const getSecret = name => { const row = db.prepare('SELECT value FROM secrets WHERE name=?').get(name); return row ? JSON.parse(row.value) : null; };
  const setSecret = (name, value) => db.prepare('INSERT INTO secrets VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value));
  const fetchFn = async (input, options) => {
    const url = new URL(input); requests.push({ url, options });
    if (remote.fail) throw new Error(`PRIVATE TOKEN ${API_TOKEN}`);
    let data;
    if (url.pathname === '/api/health') {
      const challenge = url.searchParams.get('challenge');
      data = { service: 'local-geni-public-links', version: 1, ready: true, challenge, signingProof: createHmac('sha256', remote.signingKey).update(`local-geni-health:v1:${challenge}`).digest('base64url') };
      if (remote.proof) data = remote.proof(data);
    } else if (url.pathname === '/api/optouts') data = typeof remote.feed === 'function' ? remote.feed(Number(url.searchParams.get('after'))) : remote.feed;
    else if (options.method === 'DELETE') data = { ok: true };
    else { const id = url.pathname.split('/').at(-1); data = { publicationId: id, url: `${url.origin}/p/${id}`, publishedAt: time }; }
    if (remote.mutate) data = remote.mutate(data, url, options);
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  };
  const core = createPublicPublishingCore({ db, getSecret, setSecret, normalizeEmail: normalized, emailError, fetchFn, now: () => time,
    addSuppression: ({ email, reason }) => db.prepare('INSERT INTO suppressions VALUES(?,?) ON CONFLICT(email) DO UPDATE SET reason=excluded.reason').run(email, reason) });
  const connect = body => core.configure({ origin: ORIGIN, apiToken: API_TOKEN, signingKey: SIGNING_KEY, ...body });
  return { db, core, remote, requests, getSecret, connect, tick: () => { time += 1000; } };
}

test('connection validates both keys with a unique challenge and returns masked status only', async t => {
  const f = fixture(t);
  assert.equal(f.core.getPublishingStatus().configured, false);
  assert.equal(f.core.getUnsubscribeLink({ to: 'owner@business.test' }), null);
  const status = await f.connect();
  assert.equal(status.configured, true);
  assert.equal(status.origin, ORIGIN);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(`${API_TOKEN}|${SIGNING_KEY}`));
  const first = f.requests[0];
  assert.match(first.url.searchParams.get('challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.options.headers.Authorization, `Bearer ${API_TOKEN}`);
  assert.equal(first.options.redirect, 'error');
  f.tick();
  assert.equal((await f.core.verify()).verifiedAt, 11000);
  assert.notEqual(f.requests[1].url.searchParams.get('challenge'), first.url.searchParams.get('challenge'));
});

test('wrong or missing proof never persists new credentials or replaces a working connection', async t => {
  const f = fixture(t);
  await assert.rejects(() => f.connect({ signingKey: 'x'.repeat(43) }), isCode('INVALID_PUBLISHING_KEY'));
  assert.equal(f.core.getPublishingStatus().configured, false);
  assert.equal(f.getSecret('public-publishing'), null);
  await f.connect();
  const previous = f.core.getPublishingStatus();
  const previousSecret = f.getSecret('public-publishing');
  for (const proof of [value => ({ ...value, challenge: 'z'.repeat(43) }), value => ({ ...value, signingProof: '' }), value => ({ ...value, ready: false }), () => null]) {
    f.remote.proof = proof;
    await assert.rejects(() => f.connect({ apiToken: 'y'.repeat(43) }), isCode('INVALID_PUBLISHING_SERVICE'));
    assert.deepEqual(f.core.getPublishingStatus(), previous);
    assert.deepEqual(f.getSecret('public-publishing'), previousSecret);
  }
});

test('configuration rejects local origins, malformed secrets and concurrent connection changes', async t => {
  const f = fixture(t);
  for (const origin of ['http://public.site', 'https://localhost', 'https://127.0.0.1', 'https://somewhere.local', 'https://example.test', 'https://good.site/path', 'https://user:pass@good.site', 'https://good.site:8443']) {
    await assert.rejects(() => f.connect({ origin }), isCode('INVALID_PUBLISHING_URL'));
  }
  await assert.rejects(() => f.connect({ signingKey: 'short' }), isCode('INVALID_PUBLISHING_KEY'));
  assert.equal(f.requests.length, 0);
  const first = f.connect();
  await assert.rejects(() => f.connect(), isCode('PUBLISHING_BUSY'));
  assert.throws(() => f.core.getUnsubscribeLink({ to: 'owner@business.test' }), isCode('PUBLISHING_BUSY'));
  await first;
});

test('unsubscribe IDs are stable per account/address, opaque and bound to the configured signing key', async t => {
  const f = fixture(t); await f.connect();
  const link = f.core.getUnsubscribeLink({ accountId: 1, to: ' Owner@Business.test ' });
  assert.equal(link, f.core.getUnsubscribeLink({ accountId: 1, to: 'owner@business.test' }));
  assert.notEqual(link, f.core.getUnsubscribeLink({ accountId: 2, to: 'owner@business.test' }));
  assert.doesNotMatch(link, /owner|business|account/);
  const [id, signature] = new URL(link).pathname.slice(3).split('.');
  assert.equal(signature, createHmac('sha256', SIGNING_KEY).update(`local-geni-unsubscribe:v1:${id}`).digest('base64url'));
  await assert.rejects(() => f.connect({ origin: 'https://another.site' }), isCode('PUBLISHING_IN_USE'));
  await assert.rejects(() => f.connect({ signingKey: 'x'.repeat(43) }), isCode('PUBLISHING_IN_USE'));
});

test('opt-out synchronization records known recipients transactionally and advances across pages', async t => {
  const f = fixture(t); await f.connect();
  const link = f.core.getUnsubscribeLink({ to: 'owner@business.test' });
  const known = new URL(link).pathname.slice(3).split('.')[0];
  const rows = Array.from({ length: 501 }, (_, i) => ({ sequence: i + 1, tokenId: i === 500 ? known : String(i).padStart(43, 'x'), occurredAt: 1000 + i }));
  f.remote.feed = after => ({ rows: rows.slice(after, after + 500), nextCursor: Math.min(after + 500, 501), hasMore: after === 0 });
  const first = f.core.syncPublicOptOuts();
  assert.equal(first, f.core.syncPublicOptOuts(), 'concurrent callers share one synchronization');
  const result = await first;
  assert.equal(result.cursor, 501);
  assert.equal(result.added, 1);
  assert.equal(f.db.prepare('SELECT reason FROM suppressions WHERE email=?').get('owner@business.test').reason, 'opt_out');
  assert.deepEqual(f.requests.filter(r => r.url.pathname === '/api/optouts').map(r => r.url.searchParams.get('after')), ['0', '500']);
  assert.equal((await f.core.syncPublicOptOuts()).added, 0);
});

test('invalid feeds and signing-key drift hold sending without applying a partial batch or skipping rows', async t => {
  const f = fixture(t); await f.connect();
  const tokenId = new URL(f.core.getUnsubscribeLink({ to: 'owner@business.test' })).pathname.slice(3).split('.')[0];
  const row = { sequence: 1, tokenId, occurredAt: 1000 };
  for (const data of [null, { rows: [row, null], nextCursor: 2, hasMore: false }, { rows: [row, row], nextCursor: 1, hasMore: false }, { rows: [row], nextCursor: 2, hasMore: false }, { rows: [row], nextCursor: 1, hasMore: true }, { rows: [{ ...row, occurredAt: -1 }], nextCursor: 1, hasMore: false }]) {
    f.remote.feed = data;
    await assert.rejects(() => f.core.syncPublicOptOuts(), isCode('INVALID_OPTOUT_RESPONSE'));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM suppressions').get().n, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM publishing_sync').get().n, 0);
  }
  f.remote.feed = { rows: [row], nextCursor: 1, hasMore: false };
  f.remote.signingKey = 'x'.repeat(43);
  await assert.rejects(() => f.core.syncPublicOptOuts(), isCode('INVALID_PUBLISHING_KEY'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM suppressions').get().n, 0);
  f.remote.signingKey = SIGNING_KEY;
  assert.equal((await f.core.syncPublicOptOuts()).added, 1);
});

test('unsubscribe network errors are redacted', async t => { const f=fixture(t); await f.connect(); f.remote.fail=true; await assert.rejects(()=>f.core.verify(),error=>{assert.equal(error.code,'PUBLISHING_UNAVAILABLE');assert.ok(!error.message.includes(API_TOKEN));return true;});});
