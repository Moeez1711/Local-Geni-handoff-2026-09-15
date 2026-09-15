import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
process.env.DB_PATH=':memory:';
const {db}=await import('./db.js');
const {authRouter,requireAuth}=await import('./auth.js');
let afterAuthDispatch = null;
const app=express();app.use(express.json());app.use('/api/auth',(req,res,next)=>{ next(); afterAuthDispatch?.(); });app.use('/api',requireAuth);app.use('/api/auth',authRouter);app.get('/api/private',(req,res)=>res.json({ok:true}));app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.on('listening',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
async function req(path,body,cookie,method='POST'){const r=await fetch(`${origin}/api${path}`,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,cookie:r.headers.get('set-cookie'),body:await r.json()};}
test.after(()=>{server.closeAllConnections();server.close();});
test('workspace access protects private APIs, rotates credentials, and can be disabled only with the password',async()=>{
 assert.equal((await req('/private',null,null,'GET')).status,200);
 const setup=await req('/auth/setup',{email:'qa@example.com',password:'fictional-password'});assert.equal(setup.status,200);assert.match(setup.cookie,/HttpOnly; SameSite=Strict/);const cookie=setup.cookie.split(';')[0];
 assert.equal((await req('/private',null,null,'GET')).status,401);assert.equal((await req('/private',null,cookie,'GET')).status,200);assert.equal((await req('/auth/status',null,null,'GET')).body.authenticated,false);
 assert.equal((await req('/auth/setup',{email:'qa2@example.com',password:'different-password'})).status,409);
 assert.equal((await req('/auth/login',{email:'qa@example.com',password:'incorrect'})).status,401);
 const second=await req('/auth/login',{email:'qa@example.com',password:'fictional-password'});assert.equal(second.status,200);
 const creds=await req('/auth/credentials',{email:'new@example.com',currentPassword:'fictional-password',newPassword:'revised-password'},cookie,'PUT');assert.equal(creds.status,200);assert.equal((await req('/private',null,second.cookie.split(';')[0],'GET')).status,401);
 const saved=db.prepare("SELECT value FROM settings WHERE key='auth'").get().value;assert.equal(saved.includes('revised-password'),false);assert.match(saved,/scrypt/);assert.equal((await req('/auth/status',null,cookie,'GET')).body.passwordHash,undefined);
 assert.equal((await req('/auth/disable',{currentPassword:'wrong'},cookie)).status,403);assert.equal((await req('/auth/disable',{currentPassword:'revised-password'},cookie)).status,200);assert.equal((await req('/private',null,null,'GET')).status,200);
});
test('concurrent first-time setup creates exactly one owner',async()=>{const results=await Promise.all([req('/auth/setup',{email:'first@example.com',password:'fictional-password'}),req('/auth/setup',{email:'second@example.com',password:'fictional-password'})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);db.prepare("DELETE FROM settings WHERE key='auth'").run();db.prepare('DELETE FROM sessions').run();});

test('an in-flight login cannot issue a new session after workspace credentials change', async () => {
  const setup = await req('/auth/setup', { email: 'before@example.com', password: 'fictional-password' }); assert.equal(setup.status, 200);
  const originalSessions = db.prepare('SELECT count(*) n FROM sessions').get().n;
  afterAuthDispatch = () => {
    afterAuthDispatch = null;
    const current = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='auth'").get().value);
    db.prepare("UPDATE settings SET value=? WHERE key='auth'").run(JSON.stringify({ ...current, email: 'after@example.com', updatedAt: current.updatedAt + 1 }));
  };
  const login = await req('/auth/login', { email: 'before@example.com', password: 'fictional-password' });
  assert.equal(login.status, 409); assert.equal(login.cookie, null); assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n, originalSessions);
  assert.equal((await req('/auth/login', { email: 'after@example.com', password: 'fictional-password' })).status, 200);
  db.prepare("DELETE FROM settings WHERE key='auth'").run(); db.prepare('DELETE FROM sessions').run();
});

test('an in-flight credentials update cannot overwrite a newer owner configuration', async () => {
  const setup = await req('/auth/setup', { email: 'before@example.com', password: 'fictional-password' }); const cookie = setup.cookie.split(';')[0];
  afterAuthDispatch = () => {
    afterAuthDispatch = null;
    const current = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='auth'").get().value);
    db.prepare("UPDATE settings SET value=? WHERE key='auth'").run(JSON.stringify({ ...current, email: 'newer@example.com', updatedAt: current.updatedAt + 1 }));
  };
  const result = await req('/auth/credentials', { email: 'stale@example.com', currentPassword: 'fictional-password', newPassword: 'updated-password' }, cookie, 'PUT');
  assert.equal(result.status, 409); assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='auth'").get().value).email, 'newer@example.com');
  db.prepare("DELETE FROM settings WHERE key='auth'").run(); db.prepare('DELETE FROM sessions').run();
});
