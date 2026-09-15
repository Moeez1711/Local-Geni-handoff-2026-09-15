import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
process.env.DB_PATH = ':memory:';
const { db } = await import('./db.js');
const { authRouter, requireAuth, requireWorkspacePermission, workspaceRoutePermission, assertActiveWorkspaceUser } = await import('./auth.js');
const { requireLocalEmailOrigin } = await import('./routes/email.js');
const { config } = await import('./config.js');
let afterDispatch = null;
const app = express();
app.use(express.json()); app.use('/api', requireLocalEmailOrigin);
app.use('/api/auth', (req, res, next) => { next(); afterDispatch?.(); });
app.use('/api', requireAuth); app.use('/api/auth', authRouter);
app.post('/api/explicit-schema', requireWorkspacePermission('manageSchema'), (req, res) => res.json({ ok: true }));
app.use('/api/email', requireAuth); // Exercise the same nested mounting as production.
app.use('/api', (req, res) => res.json({ ok: true, user: req.workspaceUser }));
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
config.port = server.address().port;
const origin = `http://127.0.0.1:${config.port}`;
async function call(path, method = 'GET', body, cookie, extraHeaders = {}) {
  const response = await fetch(`${origin}/api${path}`, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.json() };
}
const PW = 'fictional-team-password';
async function setup() {
  const result = await call('/auth/setup', 'POST', { name: 'QA Owner', email: 'owner@example.com', password: PW });
  assert.equal(result.status, 200);
  const status = await call('/auth/status', 'GET', undefined, result.cookie);
  return { cookie: result.cookie, user: status.body.user };
}
async function add(owner, role, name = `QA ${role}`) {
  const created = await call('/auth/team', 'POST', { name, email: `${name.toLowerCase().replaceAll(' ', '.')}@example.com`, password: PW, role }, owner.cookie);
  assert.equal(created.status, 201);
  const login = await call('/auth/login', 'POST', { identifier: name, password: PW });
  assert.equal(login.status, 200);
  return { user: created.body.user, cookie: login.cookie };
}
test.beforeEach(() => { afterDispatch = null; db.prepare("DELETE FROM settings WHERE key='auth'").run(); db.prepare('DELETE FROM sessions').run(); db.prepare('DELETE FROM workspace_users').run(); });
test.after(() => { server.closeAllConnections(); server.close(); });

test('optional access remains open and migration preserves legacy owner credentials and session', async () => {
  assert.equal((await call('/leads')).status, 200);
  assert.deepEqual((await call('/auth/team/assignable')).body.rows, []);
  assert.throws(() => assertActiveWorkspaceUser('unconfigured'), /active team/);
  const owner = await setup(), saved = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='auth'").get().value);
  db.prepare("UPDATE settings SET value=? WHERE key='auth'").run(JSON.stringify({ email: saved.email, passwordHash: saved.passwordHash, updatedAt: saved.updatedAt }));
  db.prepare('UPDATE sessions SET user_id=NULL').run(); db.prepare('DELETE FROM workspace_users').run();
  const migrated = await call('/auth/status', 'GET', undefined, owner.cookie);
  assert.equal(migrated.body.authenticated, true); assert.equal(migrated.body.user.role, 'owner');
  assert.equal((await call('/auth/login', 'POST', { email: saved.email, password: PW })).status, 200);
  assert.equal(db.prepare('SELECT password_hash FROM workspace_users WHERE active=1').get().password_hash, saved.passwordHash);
  assert.ok(!JSON.stringify(migrated.body).includes('scrypt'));
});

test('team accounts sign in by name or email and every role is enforced on nested API mutations', async () => {
  const owner = await setup(), admin = await add(owner, 'admin'), member = await add(owner, 'member'), viewer = await add(owner, 'viewer');
  const matrix = [
    ['/crm/deals', 'POST', 'edit'], ['/leads/one', 'PATCH', 'edit'], ['/previews/one', 'PUT', 'edit'], ['/preview-files/one', 'POST', 'edit'], ['/scans', 'POST', 'edit'],
    ['/email/send', 'POST', 'edit'], ['/email/campaigns/one/start', 'POST', 'edit'], ['/email/inbox/sync', 'POST', 'edit'], ['/whatsapp/send', 'POST', 'edit'], ['/whatsapp/consents/one', 'PUT', 'edit'],
    ['/email/settings', 'PUT', 'admin'], ['/EMAIL/SETTINGS/', 'PUT', 'admin'], ['/email/accounts/one/inbox', 'PUT', 'admin'], ['/email/microsoft/start', 'POST', 'admin'], ['/whatsapp/settings', 'PUT', 'admin'],
    ['/custom-fields', 'POST', 'admin'], ['/custom-fields/one/archive', 'POST', 'admin'], ['/custom-fields/leads/one', 'PUT', 'edit'], ['/publishing/settings', 'PUT', 'admin'], ['/qa/run', 'POST', 'admin'], ['/settings', 'PUT', 'admin'],
    ['/export', 'POST', 'read'], ['/export/preview', 'POST', 'read'], ['/export/columns', 'GET', 'read'], ['/preview-files/export-zip', 'POST', 'read'], ['/crm/companies', 'GET', 'read'], ['/email/messages', 'GET', 'read'],
    ['/categories', 'GET', 'read'], ['/categories/status', 'GET', 'read'], ['/categories/connection', 'PUT', 'admin'], ['/categories/connection', 'DELETE', 'admin'], ['/categories/oauth/begin', 'POST', 'admin'], ['/categories/oauth/complete', 'POST', 'admin'], ['/categories/refresh', 'POST', 'admin'], ['/categories/automatic', 'PUT', 'admin'],
  ];
  for (const [path, method, needed] of matrix) for (const account of [owner, admin, member, viewer]) {
    const allowed = needed === 'read' || ['owner', 'admin'].includes(account.user.role) || (needed === 'edit' && account.user.role === 'member');
    assert.equal((await call(path, method, method === 'GET' ? undefined : {}, account.cookie)).status, allowed ? 200 : 403, `${account.user.role} ${method} ${path}`);
  }
  assert.equal((await call('/explicit-schema', 'POST', {}, member.cookie)).status, 403);
  assert.equal((await call('/auth/team', 'GET', undefined, member.cookie)).status, 403);
  assert.equal((await call('/auth/team', 'GET', undefined, viewer.cookie)).status, 403);
  assert.equal((await call('/auth/login', 'POST', { email: 'QA.MEMBER@EXAMPLE.COM', password: PW })).status, 200);
  assert.equal((await call('/email/send', 'POST', {}, owner.cookie, { Origin: 'https://hostile.invalid' })).status, 403);
  const status = (await call('/auth/status', 'GET', undefined, viewer.cookie)).body;
  assert.deepEqual(status.permissions, ['read']); assert.equal(status.user.name, 'QA viewer');
});

test('owner protections stop self-demotion, self-disable, admin promotion and owner password takeover', async () => {
  const owner = await setup(), admin = await add(owner, 'admin'), member = await add(owner, 'member');
  assert.equal((await call(`/auth/team/${owner.user.id}`, 'PATCH', { active: false }, owner.cookie)).status, 409);
  assert.equal((await call(`/auth/team/${owner.user.id}`, 'PATCH', { role: 'member' }, owner.cookie)).status, 409);
  assert.equal((await call('/auth/disable', 'POST', { currentPassword: PW }, owner.cookie)).status, 409);
  for (const [path, method, body] of [[`/auth/team/${owner.user.id}`, 'PATCH', { name: 'Taken' }], [`/auth/team/${owner.user.id}/reset-password`, 'POST', { password: 'attacker-password' }], [`/auth/team/${owner.user.id}/revoke-sessions`, 'POST', {}], [`/auth/team/${member.user.id}`, 'PATCH', { role: 'owner' }], ['/auth/team', 'POST', { name: 'Another Owner', email: 'another@example.com', role: 'owner', password: PW }]]) {
    assert.equal((await call(path, method, body, admin.cookie)).status, 403, path);
  }
  assert.equal((await call('/auth/disable', 'POST', { currentPassword: PW }, admin.cookie)).status, 403);
  assert.equal((await call(`/auth/team/${admin.user.id}`, 'PATCH', { role: 'viewer' }, admin.cookie)).status, 409);
  assert.equal((await call('/auth/team', 'POST', { name: 'qa MEMBER', email: 'unique@example.com', role: 'member', password: PW }, owner.cookie)).status, 409);
});

test('password reset, disable, role changes and session revocation affect only their target account', async () => {
  const owner = await setup(), member = await add(owner, 'member'), viewer = await add(owner, 'viewer');
  const second = await call('/auth/login', 'POST', { identifier: member.user.name, password: PW });
  assert.equal((await call('/auth/logout-others', 'POST', {}, member.cookie)).body.signedOut, 1);
  assert.equal((await call('/leads', 'GET', undefined, second.cookie)).status, 401);
  assert.equal((await call('/leads', 'GET', undefined, viewer.cookie)).status, 200);
  assert.equal((await call(`/auth/team/${member.user.id}/reset-password`, 'POST', { password: 'replacement-password' }, owner.cookie)).status, 200);
  assert.equal((await call('/leads', 'GET', undefined, member.cookie)).status, 401);
  assert.equal((await call('/auth/login', 'POST', { identifier: member.user.name, password: PW })).status, 401);
  const renewed = await call('/auth/login', 'POST', { identifier: member.user.name, password: 'replacement-password' }); assert.equal(renewed.status, 200);
  assert.equal((await call(`/auth/team/${member.user.id}`, 'PATCH', { active: false }, owner.cookie)).status, 200);
  assert.equal((await call('/leads', 'GET', undefined, renewed.cookie)).status, 401);
  assert.equal((await call('/auth/login', 'POST', { identifier: member.user.name, password: 'replacement-password' })).status, 401);
  assert.equal((await call(`/auth/team/${viewer.user.id}`, 'PATCH', { role: 'member' }, owner.cookie)).status, 200);
  assert.equal((await call('/leads', 'GET', undefined, viewer.cookie)).status, 401);
  const relogin = await call('/auth/login', 'POST', { identifier: viewer.user.name, password: PW });
  assert.equal((await call('/email/send', 'POST', {}, relogin.cookie)).status, 200);
  assert.equal((await call('/leads', 'GET', undefined, owner.cookie)).status, 200);
});

test('assignments accept active members and exclude disabled and viewer accounts; team responses contain no secrets', async () => {
  const owner = await setup(), member = await add(owner, 'member'), viewer = await add(owner, 'viewer');
  const assignable = (await call('/auth/team/assignable', 'GET', undefined, viewer.cookie)).body.rows;
  assert.deepEqual(assignable.map(row => row.id).sort(), [owner.user.id, member.user.id].sort());
  assert.equal(assertActiveWorkspaceUser(member.user.id, { assignable: true }).id, member.user.id);
  assert.throws(() => assertActiveWorkspaceUser(viewer.user.id, { assignable: true }), /active owner/);
  await call(`/auth/team/${member.user.id}`, 'PATCH', { active: false }, owner.cookie);
  assert.throws(() => assertActiveWorkspaceUser(member.user.id), /active owner/);
  const result = await call('/auth/team', 'GET', undefined, owner.cookie);
  assert.ok(!JSON.stringify(result.body).includes(PW)); assert.ok(!JSON.stringify(result.body).includes('scrypt')); assert.ok(!JSON.stringify(result.body).includes('token_hash'));
  assert.equal(result.body.rows.find(row => row.id === owner.user.id).isPrimaryOwner, true);
});

test('concurrent administrator revocation cannot complete a pending account creation', async () => {
  const owner = await setup(), admin = await add(owner, 'admin');
  afterDispatch = () => { afterDispatch = null; db.prepare('DELETE FROM sessions WHERE user_id=?').run(admin.user.id); };
  const result = await call('/auth/team', 'POST', { name: 'Late Account', email: 'late@example.com', role: 'member', password: PW }, admin.cookie);
  assert.equal(result.status, 401); assert.equal(db.prepare("SELECT COUNT(*) n FROM workspace_users WHERE email='late@example.com'").get().n, 0);
});

test('malformed stored access fails closed and role mapping normalizes case and encoded route names', async () => {
  db.prepare("INSERT INTO settings(key,value) VALUES('auth','not-json')").run();
  assert.equal((await call('/leads')).status, 503);
  assert.equal(workspaceRoutePermission('PUT', '/api/%65mail/settings?x=1'), 'manageConnections');
  assert.equal(workspaceRoutePermission('PATCH', '/API/EMAIL/SETTINGS/'), 'manageConnections');
  assert.equal(workspaceRoutePermission('POST', '/api/unclassified-feature'), 'manageWorkspace');
});
