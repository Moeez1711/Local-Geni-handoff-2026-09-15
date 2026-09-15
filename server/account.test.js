import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
process.env.DB_PATH = ':memory:';
const { db } = await import('./db.js');
const { authRouter, requireAuth } = await import('./auth.js');
const { requireLocalEmailOrigin } = await import('./routes/email.js');
const { config } = await import('./config.js');
const app = express();
app.use(express.json()); app.use('/api', requireLocalEmailOrigin, requireAuth); app.use('/api/auth', authRouter);
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
config.port = server.address().port;
const origin = `http://127.0.0.1:${config.port}`, PW = 'fictional-account-password';
async function call(path, method = 'GET', body, cookie) {
  const res = await fetch(`${origin}/api/auth${path}`, {method, headers:{Origin:origin, 'Content-Type':'application/json', ...(cookie ? {Cookie:cookie} : {})}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
  return {status:res.status, body:await res.json(), cookie:res.headers.get('set-cookie')?.split(';')[0]};
}
async function setup() { const result = await call('/setup','POST',{name:'QA Owner',email:'owner@example.com',password:PW}); assert.equal(result.status,200); return result.cookie; }
async function member(owner, role = 'member') { const created = await call('/team','POST',{name:`QA ${role}`,email:`${role}@example.com`,role,password:PW},owner); assert.equal(created.status,201); const login = await call('/login','POST',{identifier:`${role}@example.com`,password:PW}); return {cookie:login.cookie,user:created.body.user}; }
async function invite(cookie, extra = {}) { return call('/team/invitations','POST',{email:'invitee@example.com',role:'member',...extra},cookie); }
test.beforeEach(() => { db.prepare("DELETE FROM settings WHERE key='auth'").run(); db.exec('DELETE FROM workspace_invitations; DELETE FROM sessions; DELETE FROM workspace_users;'); });
test.after(() => { server.closeAllConnections(); server.close(); });

test('profile stores name and photo; sensitive changes require current password and preserve role', async () => {
  const owner = await setup(), user = await member(owner);
  const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOxQAAAAASUVORK5CYII=';
  const updated = await call('/profile','PUT',{name:'New QA name',avatar,role:'owner'},user.cookie);
  assert.equal(updated.status,200); assert.equal(updated.body.user.role,'member'); assert.equal(updated.body.user.avatar,avatar);
  assert.equal((await call('/status','GET',undefined,user.cookie)).body.user.name,'New QA name');
  assert.equal((await call('/profile','PUT',{email:'changed@example.com'},user.cookie)).status,403);
  assert.equal((await call('/profile','PUT',{email:'changed@example.com',currentPassword:PW},user.cookie)).status,200);
  assert.equal((await call('/profile','PUT',{avatar:null},user.cookie)).body.user.avatar,null);
  assert.equal((await call('/profile','PUT',{avatar:'data:image/svg+xml;base64,PHN2Zy8+'},user.cookie)).status,400);
  assert.equal((await call('/profile','PUT',{avatar:'data:image/png;base64,aGVsbG8='},user.cookie)).status,400);
  assert.equal((await call('/profile','PUT',{name:'QA Owner'},user.cookie)).status,409);
});

test('profile password change invalidates only other sessions and owner migration preserves profile', async () => {
  const owner = await setup(), other = await call('/login','POST',{identifier:'owner@example.com',password:PW});
  const nextPW = 'changed-fictional-password';
  assert.equal((await call('/profile','PUT',{name:'Updated Owner',newPassword:nextPW,currentPassword:PW},owner)).status,200);
  assert.equal((await call('/status','GET',undefined,other.cookie)).body.authenticated,false);
  assert.equal((await call('/status','GET',undefined,owner)).body.user.name,'Updated Owner');
  assert.equal((await call('/login','POST',{identifier:'Updated Owner',password:nextPW})).status,200);
});

test('session list uses opaque noncredential IDs and revocation cannot affect another user', async () => {
  const owner = await setup(), user = await member(owner), other = await call('/login','POST',{identifier:'owner@example.com',password:PW});
  const list = (await call('/sessions','GET',undefined,owner)).body.rows;
  assert.equal(list.length,2); assert.equal(list.filter(row => row.current).length,1);
  assert.ok(list.every(row => row.id && row.createdAt && row.lastSeen));
  assert.ok(!JSON.stringify(list).includes('token_hash'));
  const target = list.find(row => !row.current);
  assert.equal((await call(`/sessions/${target.id}`,'DELETE',undefined,user.cookie)).status,404);
  assert.equal((await call(`/sessions/${target.id}`,'DELETE',undefined,owner)).status,200);
  assert.equal((await call('/status','GET',undefined,other.cookie)).body.authenticated,false);
  assert.equal((await call('/status','GET',undefined,user.cookie)).body.authenticated,true);
  const team = (await call('/team','GET',undefined,owner)).body.rows;
  assert.ok(team.every(row => row.lastLoginAt));
});

test('invitations are hashed, unique, single use, and accepted with the assigned role and email', async () => {
  const owner = await setup(), created = await invite(owner);
  assert.equal(created.status,201); const {token,invitation} = created.body;
  assert.equal(token.length,43); assert.equal((await invite(owner)).status,409);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM workspace_invitations').all()).includes(token));
  assert.ok(!JSON.stringify((await call('/team/invitations','GET',undefined,owner)).body).includes(token));
  assert.equal((await call('/invitation/lookup','POST',{token})).body.invitation.email,'invitee@example.com');
  const joined = await call('/invitation/accept','POST',{token,name:'Invited QA',password:PW,email:'attacker@example.com',role:'owner'});
  assert.equal(joined.status,201); assert.equal(joined.body.user.role,'member'); assert.equal(joined.body.user.email,'invitee@example.com');
  assert.equal((await call('/status','GET',undefined,joined.cookie)).body.authenticated,true);
  assert.equal((await call('/invitation/accept','POST',{token,name:'Another QA',password:PW})).status,410);
  assert.equal((await call(`/team/invitations/${invitation.id}`,'DELETE',undefined,owner)).status,409);
});

test('invitation permissions protect owners, revoke and expire links, and reject account collisions', async () => {
  const owner = await setup(), admin = await member(owner,'admin'), viewer = await member(owner,'viewer');
  assert.equal((await invite(viewer.cookie)).status,403);
  assert.equal((await invite(admin.cookie,{role:'owner'})).status,403);
  assert.equal((await invite(owner,{email:'viewer@example.com'})).status,409);
  const created = await invite(owner,{role:'owner'}), token = created.body.token, id = created.body.invitation.id;
  assert.equal((await call(`/team/invitations/${id}`,'DELETE',undefined,admin.cookie)).status,403);
  assert.equal((await call(`/team/invitations/${id}`,'DELETE',undefined,owner)).status,200);
  assert.equal((await call('/invitation/lookup','POST',{token})).status,410);
  const replacement = await invite(owner); assert.equal(replacement.status,201);
  db.prepare('UPDATE workspace_invitations SET expires_at=0 WHERE id=?').run(replacement.body.invitation.id);
  assert.equal((await call('/invitation/accept','POST',{token:replacement.body.token,name:'Expired QA',password:PW})).status,410);
});

test('revoked inviter and concurrent acceptance cannot grant extra accounts', async () => {
  const owner = await setup(), admin = await member(owner,'admin'), created = await invite(admin.cookie);
  await call(`/team/${admin.user.id}`,'PATCH',{active:false},owner);
  assert.equal((await call('/invitation/lookup','POST',{token:created.body.token})).status,410);
  const second = await invite(owner,{email:'second@example.com'});
  const attempts = await Promise.all([1,2].map(n => call('/invitation/accept','POST',{token:second.body.token,name:`Concurrent QA ${n}`,password:PW})));
  assert.deepEqual(attempts.map(row => row.status).sort(),[201,410]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM workspace_users WHERE email='second@example.com'").get().n,1);
});

test('removing and recreating workspace sign-in invalidates previous invitation links', async () => {
  const owner = await setup(), created = await invite(owner);
  assert.equal((await call('/disable','POST',{currentPassword:PW},owner)).status,200);
  await setup();
  assert.equal((await call('/invitation/lookup','POST',{token:created.body.token})).status,410);
});
