import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns/promises';
import http from 'node:http';
process.env.DB_PATH = ':memory:';
const { db } = await import('./db.js');
const { createQaEnvironment } = await import('./qaAgent.js');
const { createEmailVault } = await import('./emailVault.js');

test('QA child environment excludes real account credentials, key paths and inherited Node options', () => {
  const source = { PATH: '/usr/bin', TMPDIR: '/tmp', LANG: 'en_US.UTF-8', DB_PATH: '/private/live.db', EMAIL_KEY_PATH: '/private/live.key', GOOGLE_PLACES_API_KEY: 'LIVE_SECRET', NODE_OPTIONS: '--require private-module', AWS_SECRET_ACCESS_KEY: 'LIVE_SECRET', PUBLISH_TOKEN: 'LIVE_SECRET' };
  const env = createQaEnvironment(source);
  assert.equal(env.DB_PATH, ':memory:'); assert.equal(env.LOCAL_GENI_QA_ISOLATED, '1'); assert.equal(env.LOCAL_GENI_QA_DISABLED, '1');
  assert.equal(env.GOOGLE_PLACES_API_KEY, ''); assert.equal(env.EMAIL_KEY_PATH, ''); assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined); assert.equal(env.PUBLISH_TOKEN, undefined); assert.ok(!JSON.stringify(env).includes('LIVE_SECRET'));
});

test('memory database vaults never inspect or write a production key file, even if the parent supplied its path', (t) => {
  const previous = process.env.EMAIL_KEY_PATH; process.env.EMAIL_KEY_PATH = '/must-not-touch/live.key';
  t.after(() => { if (previous === undefined) delete process.env.EMAIL_KEY_PATH; else process.env.EMAIL_KEY_PATH = previous; });
  for (const name of ['existsSync', 'readFileSync', 'writeFileSync', 'mkdirSync', 'lstatSync']) t.mock.method(fs, name, () => assert.fail('In-memory vault touched the filesystem'));
  const first = createEmailVault(), second = createEmailVault();
  const sealed = first.seal({ password: 'FICTIONAL_SECRET' }, 'memory-test');
  assert.equal(second.open(sealed, 'memory-test').password, 'FICTIONAL_SECRET'); assert.ok(!sealed.includes('FICTIONAL_SECRET'));
});

test('QA network isolation permits its own ephemeral HTTP test server and blocks live app, DNS and provider connections', async (t) => {
  process.env.LOCAL_GENI_QA_ISOLATED = '1'; await import('../scripts/qa-isolation.mjs');
  const server = http.createServer((req, res) => res.end('isolated fixture'));
  server.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}`)).text(), 'isolated fixture');
  const isBlocked = (e) => e.code === 'QA_NETWORK_BLOCKED';
  await assert.rejects(fetch('http://127.0.0.1:4000/api/leads'), isBlocked);
  await assert.rejects(fetch('https://graph.microsoft.com/v1.0/me'), isBlocked);
  await assert.rejects(dns.resolveMx('gmail.com'), isBlocked);
  await assert.rejects(new dns.Resolver().resolveMx('gmail.com'), isBlocked);
  assert.throws(() => net.connect({ host: 'smtp.gmail.com', port: 465 }), isBlocked);
});

test.after(() => db.close());
