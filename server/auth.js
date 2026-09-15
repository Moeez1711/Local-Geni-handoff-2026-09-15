/** Optional local workspace access, individual team accounts, and server-side roles. */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { Router } from 'express';
import { db, json, tx } from './db.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'ls_session', DAY = 86400000, LOCK_MS = 15 * 60000;
const ROLES = ['owner', 'admin', 'member', 'viewer'];
export const WORKSPACE_PERMISSIONS = ['read', 'editLeads', 'outreach', 'manageConnections', 'manageTeam', 'manageSchema', 'manageWorkspace'];
const ROLE_PERMISSIONS = { owner: WORKSPACE_PERMISSIONS, admin: WORKSPACE_PERMISSIONS, member: ['read', 'editLeads', 'outreach'], viewer: ['read'] };
const error = (status, message, code = 'AUTH_INVALID') => Object.assign(new Error(message), { status, code, authSafe: true });
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const readAuth = () => {
  const row = db.prepare("SELECT value FROM settings WHERE key='auth'").get();
  if (!row) return null;
  const value = json(row.value, null);
  if (!value || typeof value !== 'object' || typeof value.email !== 'string' || typeof value.passwordHash !== 'string') throw error(503, 'Workspace access needs local recovery.', 'AUTH_RECOVERY_REQUIRED');
  return value;
};
const writeAuth = value => db.prepare("INSERT INTO settings(key,value) VALUES('auth',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));

db.exec(`CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, user_agent TEXT
);
CREATE TABLE IF NOT EXISTS workspace_users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1, password_hash TEXT NOT NULL, revision TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_user_email ON workspace_users(email COLLATE NOCASE) WHERE active=1;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_user_name ON workspace_users(name COLLATE NOCASE) WHERE active=1;`);
if (!db.prepare('PRAGMA table_info(sessions)').all().some(row => row.name === 'user_id')) db.exec('ALTER TABLE sessions ADD COLUMN user_id TEXT');
if (!db.prepare('PRAGMA table_info(sessions)').all().some(row => row.name === 'public_id')) {
  db.exec('ALTER TABLE sessions ADD COLUMN public_id TEXT');
  for (const row of db.prepare('SELECT token_hash FROM sessions').all()) db.prepare('UPDATE sessions SET public_id=? WHERE token_hash=?').run(crypto.randomUUID(), row.token_hash);
}
for (const [column, type] of [['avatar', 'TEXT'], ['last_login_at', 'INTEGER']]) {
  if (!db.prepare('PRAGMA table_info(workspace_users)').all().some(row => row.name === column)) db.exec(`ALTER TABLE workspace_users ADD COLUMN ${column} ${type}`);
}
db.exec(`CREATE TABLE IF NOT EXISTS workspace_invitations (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL,
 invited_by TEXT NOT NULL, workspace_owner TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 revoked_at INTEGER, accepted_at INTEGER
);`);
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

const userById = id => db.prepare('SELECT * FROM workspace_users WHERE id=?').get(id);
const safeUser = row => ({ id: row.id, name: row.name, email: row.email, role: row.role, avatar: row.avatar || null, lastLoginAt: row.last_login_at || null, active: !!row.active, isPrimaryOwner: readAuth()?.ownerId === row.id, createdAt: row.created_at, updatedAt: row.updated_at });

/** Keep the original owner credentials and existing sessions during migration. */
function configuredAuth() {
  let auth = readAuth();
  if (!auth) return null;
  if (!auth.ownerId) {
    const id = crypto.randomUUID(), now = Date.now();
    tx(() => {
      db.prepare('UPDATE workspace_users SET active=0').run();
      db.prepare('INSERT INTO workspace_users(id,name,email,role,active,password_hash,revision,created_at,updated_at) VALUES(?,?,?,\'owner\',1,?,?,?,?)').run(id, auth.name || 'Owner', auth.email, auth.passwordHash, crypto.randomUUID(), now, auth.updatedAt || now);
      auth = { ...auth, ownerId: id, name: auth.name || 'Owner' }; writeAuth(auth);
      db.prepare('UPDATE sessions SET user_id=? WHERE user_id IS NULL').run(id);
    });
  } else {
    const owner = userById(auth.ownerId);
    if (!owner) throw error(503, 'Workspace access needs local recovery. Run reset-login with the app stopped.', 'AUTH_RECOVERY_REQUIRED');
    if (owner.email !== auth.email || owner.password_hash !== auth.passwordHash || owner.updated_at !== auth.updatedAt || owner.name !== auth.name) {
      db.prepare('UPDATE workspace_users SET name=?,email=?,password_hash=?,revision=?,updated_at=? WHERE id=?').run(auth.name || owner.name, auth.email, auth.passwordHash, crypto.randomUUID(), auth.updatedAt || Date.now(), owner.id);
    }
  }
  return auth;
}
function mirrorOwner(user) {
  const auth = readAuth();
  if (auth?.ownerId === user.id) writeAuth({ ...auth, name: user.name, email: user.email, passwordHash: user.password_hash, updatedAt: user.updated_at });
}
function cleanName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[@\x00-\x1f\x7f]/.test(value)) throw error(400, 'Enter a name of 1 to 80 characters, without @ or line breaks.');
  return value.trim();
}
function cleanEmail(value) {
  if (typeof value !== 'string') throw error(400, 'Enter a valid email address.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw error(400, 'Enter a valid email address.');
  return email;
}
function checkPassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 200) throw error(400, 'Use a password between 8 and 200 characters.');
  return value;
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16), key = await scrypt(password.normalize('NFKC'), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}
const DUMMY_HASH = `scrypt$16384$8$1$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(64).toString('base64')}`;
async function verifyPassword(password, stored = DUMMY_HASH) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== 'scrypt$16384$8$1') return false;
  const salt = Buffer.from(parts[4], 'base64'), expected = Buffer.from(parts[5], 'base64');
  if (salt.length !== 16 || expected.length !== 64) return false;
  const valid = typeof password === 'string' && password.length <= 200;
  const key = await scrypt((valid ? password : '').normalize('NFKC'), salt, 64, { N: 16384, r: 8, p: 1 });
  return valid && crypto.timingSafeEqual(key, expected);
}
const failures = new Map();
function failureKey(identifier) { return sha256(String(identifier || '').toLowerCase().slice(0, 254)); }
function assertNotLocked(key) {
  const current = failures.get(key), now = Date.now();
  if (current && now - current.first < LOCK_MS && current.count >= 5) throw error(429, 'Too many failed attempts. Try again in 15 minutes.', 'AUTH_RATE_LIMITED');
  if (current && now - current.first >= LOCK_MS) failures.delete(key);
}
function recordFailure(key) {
  if (failures.size > 1000) failures.delete(failures.keys().next().value);
  const now = Date.now(), previous = failures.get(key);
  failures.set(key, previous && now - previous.first < LOCK_MS ? { ...previous, count: previous.count + 1 } : { first: now, count: 1 });
}
function tokenFrom(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === COOKIE) return value.join('=') || null;
  }
  return null;
}
function sessionFor(req) {
  const token = tokenFrom(req);
  if (!token || token.length > 200) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(sha256(token));
  if (!session || session.expires_at <= Date.now()) return null;
  const user = session.user_id && userById(session.user_id);
  if (!user?.active) return null;
  if (Date.now() - session.last_seen > 300000) db.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?').run(Date.now(), session.token_hash);
  return { ...session, user };
}
function startSession(req, res, userId, remember) {
  const token = crypto.randomBytes(32).toString('base64url'), ttl = (remember ? 30 : 1) * DAY, now = Date.now();
  db.prepare('INSERT INTO sessions(token_hash,created_at,expires_at,last_seen,user_agent,user_id,public_id) VALUES(?,?,?,?,?,?,?)').run(sha256(token), now, now + ttl, now, String(req.headers['user-agent'] || '').slice(0, 200), userId, crypto.randomUUID());
  db.prepare('UPDATE workspace_users SET last_login_at=? WHERE id=?').run(now, userId);
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.append('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=${isHttps ? 'None; Secure' : 'Strict'}; Path=/; Max-Age=${ttl / 1000}`);
}
const clearCookie = (res, req) => {
  const isHttps = req?.secure || req?.headers?.['x-forwarded-proto'] === 'https';
  res.append('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=${isHttps ? 'None; Secure' : 'Strict'}; Path=/; Max-Age=0`);
};
function currentActor(req, permission) {
  if (!configuredAuth()) throw error(409, 'Enable workspace sign-in before managing team accounts.', 'AUTH_SETUP_REQUIRED');
  const session = sessionFor(req);
  if (!session) throw error(401, 'Sign in required.', 'AUTH_REQUIRED');
  if (permission && !ROLE_PERMISSIONS[session.user.role]?.includes(permission)) throw error(403, 'Your role does not allow this action.', 'AUTH_FORBIDDEN');
  return session.user;
}
function assertUnchanged(user, authSnapshot) {
  configuredAuth();
  if (JSON.stringify(readAuth()) !== JSON.stringify(authSnapshot) || userById(user.id)?.revision !== user.revision || !userById(user.id)?.active) throw error(409, 'Workspace access changed. Sign in again with the current credentials.', 'AUTH_CHANGED');
}
async function requireCurrentPassword(req, password) {
  const user = currentActor(req), auth = readAuth(), key = failureKey(user.id);
  assertNotLocked(key);
  if (!await verifyPassword(password, user.password_hash)) { recordFailure(key); throw error(403, 'Current password is incorrect.'); }
  assertUnchanged(user, auth); currentActor(req); failures.delete(key);
  return { user, auth };
}
function assertUnique(name, email, exceptId = '') {
  if (db.prepare('SELECT id FROM workspace_users WHERE active=1 AND id!=? AND (name=? COLLATE NOCASE OR email=? COLLATE NOCASE)').get(exceptId, name, email)) throw error(409, 'An active account already uses that name or email.', 'AUTH_DUPLICATE');
}
export function assertActiveWorkspaceUser(id, { assignable = false } = {}) {
  if (!configuredAuth() || typeof id !== 'string') throw error(400, 'Choose an active team member.', 'AUTH_ASSIGNEE_INVALID');
  const user = userById(id);
  if (!user?.active || (assignable && user.role === 'viewer')) throw error(400, 'Choose an active owner, admin, or member.', 'AUTH_ASSIGNEE_INVALID');
  return safeUser(user);
}
export function listAssignableWorkspaceUsers() {
  if (!configuredAuth()) return [];
  return db.prepare("SELECT * FROM workspace_users WHERE active=1 AND role IN ('owner','admin','member') ORDER BY name COLLATE NOCASE").all().map(safeUser);
}

const OPEN = new Set(['GET /auth/status', 'POST /auth/login', 'POST /auth/setup', 'POST /auth/logout', 'POST /auth/invitation/lookup', 'POST /auth/invitation/accept']);
export function workspaceRoutePermission(method, path) {
  let route;
  try { route = decodeURIComponent(String(path).split('?')[0]).toLowerCase().replace(/^\/api(?=\/|$)/, '').replace(/\/+$/, '') || '/'; } catch { return 'manageWorkspace'; }
  const verb = method.toUpperCase();
  if (route === '/auth/team/assignable') return 'read';
  if (route.startsWith('/auth/team')) return 'manageTeam';
  if (route.startsWith('/auth/')) return 'read';
  if (['GET', 'HEAD', 'OPTIONS'].includes(verb)) return 'read';
  if (route === '/export' || route === '/export/preview' || route === '/preview-files/export-zip') return 'read';
  if (route === '/lists/preview') return 'read';
  if (route.startsWith('/lists')) return route.endsWith('/recipients') ? 'outreach' : 'editLeads';
  if (route.startsWith('/crm')) return 'editLeads';
  if (route.startsWith('/custom-fields/leads/')) return 'editLeads';
  if (route.startsWith('/custom-fields')) return 'manageSchema';
  if (route === '/settings' || route === '/limits' || route.startsWith('/qa/')) return 'manageWorkspace';
  if (route.startsWith('/publishing/')) return 'manageConnections';
  if (route.startsWith('/sms/') || route.startsWith('/assistant/')) return 'outreach';
  if (route === '/integrations' || route.startsWith('/integrations/')) return 'manageConnections';
  if (route === '/categories' || route.startsWith('/categories/')) return 'manageConnections';
  if (route.startsWith('/preview-files/')) return 'editLeads';
  if (route.startsWith('/previews/')) return route.endsWith('/activity') ? 'outreach' : 'editLeads';
  if (route.startsWith('/leads') || route.startsWith('/scans') || route === '/area/resolve') return 'editLeads';
  if (route.startsWith('/whatsapp/')) return /^\/whatsapp\/(settings|verify|connection|inbox\/settings(?:\/|$)|templates(?:\/|$))/.test(route) ? 'manageConnections' : 'outreach';
  if (route.startsWith('/email/')) {
    if (/^\/email\/accounts\/[^/]+\/select$/.test(route)) return 'outreach';
    if (/^\/email\/(accounts(?:\/|$)|settings$|verify$|connection$|microsoft\/|policy$|infrastructure$|domain\/|dkim\/|verifier$)/.test(route)) return 'manageConnections';
    return 'outreach';
  }
  return 'manageWorkspace';
}
export function requireWorkspacePermission(permission) {
  return (req, res, next) => {
    try {
      if (!configuredAuth()) { req.workspaceUser = null; req.workspacePermissions = WORKSPACE_PERMISSIONS; return next(); }
      const user = currentActor(req, permission); req.workspaceUser = safeUser(user); req.user = req.workspaceUser; req.workspacePermissions = ROLE_PERMISSIONS[user.role]; next();
    } catch (e) { res.status(e.status || 500).json({ error: e.authSafe ? e.message : 'Workspace access could not be checked.', code: e.code || 'AUTH_ERROR' }); }
  };
}
export function requireAuth(req, res, next) {
  const full = req.originalUrl || req.url || req.path;
  let route; try { route = decodeURIComponent(String(full).split('?')[0]).toLowerCase().replace(/^\/api(?=\/|$)/, '').replace(/\/+$/, ''); } catch { route = ''; }
  if (OPEN.has(`${req.method} ${route}`)) return next();
  return requireWorkspacePermission(workspaceRoutePermission(req.method, full))(req, res, next);
}

/** Bind long-running provider operations to the same current account and session. */
export function workspacePermissionBinding(req, permission) {
  if (!configuredAuth()) return 'local-access';
  const user = currentActor(req, permission);
  return sha256(JSON.stringify([user.id, user.revision, tokenFrom(req)]));
}

export const authRouter = Router();
authRouter.get('/status', (req, res) => {
  const auth = configuredAuth();
  if (!auth) return res.json({ configured: false, authenticated: true, user: null, role: 'owner', permissions: WORKSPACE_PERMISSIONS });
  const session = sessionFor(req);
  if (!session) return res.json({ configured: true, authenticated: false, permissions: [] });
  const user = safeUser(session.user);
  res.json({ configured: true, authenticated: true, user, role: user.role, email: user.email, updatedAt: user.updatedAt, permissions: ROLE_PERMISSIONS[user.role], sessionExpiresAt: session.expires_at, sessions: db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=? AND expires_at>?').get(user.id, Date.now()).n });
});
authRouter.post('/setup', async (req, res) => {
  if (configuredAuth()) throw error(409, 'Sign-in is already set up. Update it from Workspace access.');
  const email = cleanEmail(req.body?.email), name = cleanName(req.body?.name || 'Owner'), passwordHash = await hashPassword(checkPassword(req.body?.password));
  if (configuredAuth()) throw error(409, 'Sign-in is already set up.');
  const old = db.prepare('SELECT id FROM workspace_users WHERE email=? COLLATE NOCASE ORDER BY updated_at DESC LIMIT 1').get(email), id = old?.id || crypto.randomUUID(), now = Date.now();
  tx(() => {
    db.prepare('UPDATE workspace_users SET active=0').run();
    db.prepare("INSERT INTO workspace_users(id,name,email,role,active,password_hash,revision,created_at,updated_at) VALUES(?,?,?,'owner',1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,role='owner',active=1,password_hash=excluded.password_hash,revision=excluded.revision,updated_at=excluded.updated_at").run(id, name, email, passwordHash, crypto.randomUUID(), now, now);
    writeAuth({ ownerId: id, name, email, passwordHash, updatedAt: now }); db.exec('DELETE FROM sessions'); db.prepare('UPDATE workspace_invitations SET revoked_at=? WHERE revoked_at IS NULL AND accepted_at IS NULL').run(now); startSession(req, res, id, true);
  });
  res.json({ ok: true });
});
authRouter.post('/login', async (req, res) => {
  const auth = configuredAuth(); if (!auth) throw error(409, 'Sign-in is not set up.');
  const identifier = String(req.body?.identifier ?? req.body?.email ?? '').trim().toLowerCase().slice(0, 254);
  const user = db.prepare('SELECT * FROM workspace_users WHERE active=1 AND (email=? COLLATE NOCASE OR name=? COLLATE NOCASE)').get(identifier, identifier);
  const key = failureKey(user?.id || identifier); assertNotLocked(key);
  const ok = await verifyPassword(req.body?.password, user?.password_hash || DUMMY_HASH);
  if (!ok || !user) { recordFailure(key); throw error(401, 'Name, email, or password is incorrect.', 'AUTH_LOGIN_FAILED'); }
  assertUnchanged(user, auth); failures.delete(key); startSession(req, res, user.id, req.body?.remember !== false); res.json({ ok: true });
});
authRouter.post('/logout', (req, res) => { const token = tokenFrom(req); if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(token)); clearCookie(res); res.json({ ok: true }); });
authRouter.post('/logout-others', (req, res) => { const user = currentActor(req); res.json({ ok: true, signedOut: Number(db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').run(user.id, sha256(tokenFrom(req) || '')).changes) }); });
authRouter.put('/credentials', async (req, res) => {
  const { user, auth } = await requireCurrentPassword(req, req.body?.currentPassword);
  const email = cleanEmail(req.body?.email ?? user.email), name = cleanName(req.body?.name ?? user.name), passwordHash = req.body?.newPassword ? await hashPassword(checkPassword(req.body.newPassword)) : user.password_hash;
  assertUnchanged(user, auth); currentActor(req); assertUnique(name, email, user.id);
  tx(() => {
    db.prepare('UPDATE workspace_users SET name=?,email=?,password_hash=?,revision=?,updated_at=? WHERE id=?').run(name, email, passwordHash, crypto.randomUUID(), Date.now(), user.id); mirrorOwner(userById(user.id));
    if (req.body?.newPassword) db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').run(user.id, sha256(tokenFrom(req) || ''));
  }); res.json({ ok: true });
});
authRouter.post('/disable', async (req, res) => {
  const { user } = await requireCurrentPassword(req, req.body?.currentPassword);
  if (user.role !== 'owner') throw error(403, 'Only an owner can remove workspace sign-in.', 'AUTH_FORBIDDEN');
  if (db.prepare('SELECT 1 FROM workspace_users WHERE active=1 AND id!=?').get(user.id)) throw error(409, 'Disable the other team accounts before removing workspace sign-in.');
  tx(() => { db.prepare("DELETE FROM settings WHERE key='auth'").run(); db.exec('DELETE FROM sessions'); db.prepare('UPDATE workspace_users SET active=0').run(); db.prepare('UPDATE workspace_invitations SET revoked_at=? WHERE revoked_at IS NULL AND accepted_at IS NULL').run(Date.now()); }); clearCookie(res); res.json({ ok: true });
});
authRouter.get('/team/assignable', (req, res) => res.json({ rows: listAssignableWorkspaceUsers() }));
authRouter.get('/team', (req, res) => { currentActor(req, 'manageTeam'); res.json({ rows: db.prepare('SELECT * FROM workspace_users ORDER BY active DESC,name COLLATE NOCASE').all().map(row => ({ ...safeUser(row), sessions: db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=? AND expires_at>?').get(row.id, Date.now()).n })) }); });
function canEditUser(actor, target, nextRole = target.role, active = !!target.active) {
  if (actor.role !== 'owner' && (target.role === 'owner' || nextRole === 'owner')) throw error(403, 'Only an owner can manage owner accounts.', 'AUTH_FORBIDDEN');
  if (target.id === actor.id && (nextRole !== target.role || !active)) throw error(409, 'You cannot change your own role or disable your own account.');
  if (target.role === 'owner' && target.active && (nextRole !== 'owner' || !active) && db.prepare("SELECT COUNT(*) n FROM workspace_users WHERE role='owner' AND active=1").get().n <= 1) throw error(409, 'Keep at least one active owner.');
  if (readAuth()?.ownerId === target.id && (nextRole !== 'owner' || !active)) throw error(409, 'The original workspace owner must stay active.');
}
authRouter.post('/team', async (req, res) => {
  let actor = currentActor(req, 'manageTeam');
  const name = cleanName(req.body?.name), email = cleanEmail(req.body?.email), role = req.body?.role || 'member';
  if (!ROLES.includes(role) || (role === 'owner' && actor.role !== 'owner')) throw error(403, 'You cannot assign that role.', 'AUTH_FORBIDDEN');
  assertUnique(name, email); const passwordHash = await hashPassword(checkPassword(req.body?.password)); actor = currentActor(req, 'manageTeam');
  if (role === 'owner' && actor.role !== 'owner') throw error(403, 'Only an owner can add another owner.', 'AUTH_FORBIDDEN');
  assertUnique(name, email); const id = crypto.randomUUID(), now = Date.now();
  db.prepare('INSERT INTO workspace_users(id,name,email,role,active,password_hash,revision,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,?)').run(id, name, email, role, passwordHash, crypto.randomUUID(), now, now);
  res.status(201).json({ user: safeUser(userById(id)) });
});
authRouter.patch('/team/:id', (req, res) => {
  const actor = currentActor(req, 'manageTeam'), target = userById(req.params.id); if (!target) throw error(404, 'Team account not found.');
  const role = req.body?.role ?? target.role, active = req.body?.active ?? !!target.active, name = cleanName(req.body?.name ?? target.name), email = cleanEmail(req.body?.email ?? target.email);
  if (!ROLES.includes(role) || typeof active !== 'boolean') throw error(400, 'Choose a valid role and account status.');
  canEditUser(actor, target, role, active); if (active) assertUnique(name, email, target.id);
  tx(() => {
    db.prepare('UPDATE workspace_users SET name=?,email=?,role=?,active=?,revision=?,updated_at=? WHERE id=?').run(name, email, role, active ? 1 : 0, crypto.randomUUID(), Date.now(), target.id); mirrorOwner(userById(target.id));
    if (!active || role !== target.role) db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
  }); res.json({ user: safeUser(userById(target.id)) });
});
authRouter.post('/team/:id/reset-password', async (req, res) => {
  let actor = currentActor(req, 'manageTeam'); const target = userById(req.params.id); if (!target) throw error(404, 'Team account not found.'); canEditUser(actor, target);
  if (target.id === actor.id) throw error(409, 'Change your own password with your current password above.');
  const hash = await hashPassword(checkPassword(req.body?.password)); actor = currentActor(req, 'manageTeam'); const current = userById(target.id);
  if (!current || current.revision !== target.revision) throw error(409, 'This team account changed. Refresh before resetting its password.'); canEditUser(actor, current);
  tx(() => { db.prepare('UPDATE workspace_users SET password_hash=?,revision=?,updated_at=? WHERE id=?').run(hash, crypto.randomUUID(), Date.now(), target.id); mirrorOwner(userById(target.id)); db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id); }); res.json({ ok: true });
});
authRouter.post('/team/:id/revoke-sessions', (req, res) => {
  const actor = currentActor(req, 'manageTeam'), target = userById(req.params.id); if (!target) throw error(404, 'Team account not found.'); canEditUser(actor, target);
  const signedOut = Number(db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id).changes); if (target.id === actor.id) clearCookie(res); res.json({ ok: true, signedOut });
});
function cleanAvatar(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 130000) throw error(400, 'Choose a smaller profile picture.');
  const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw error(400, 'Use a PNG, JPEG, or WebP picture.');
  const bytes = Buffer.from(match[2], 'base64');
  const valid = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid || bytes.length > 96000) throw error(400, 'Use a valid picture under 96 KB after resizing.');
  return value;
}
authRouter.put('/profile', async (req, res) => {
  let user = currentActor(req), auth = readAuth();
  const email = cleanEmail(req.body?.email ?? user.email), name = cleanName(req.body?.name ?? user.name);
  const avatar = req.body?.avatar === undefined ? user.avatar : cleanAvatar(req.body.avatar);
  if (email !== user.email || req.body?.newPassword) ({ user, auth } = await requireCurrentPassword(req, req.body?.currentPassword));
  const passwordHash = req.body?.newPassword ? await hashPassword(checkPassword(req.body.newPassword)) : user.password_hash;
  assertUnchanged(user, auth); currentActor(req); assertUnique(name, email, user.id);
  tx(() => {
    db.prepare('UPDATE workspace_users SET name=?,email=?,avatar=?,password_hash=?,revision=?,updated_at=? WHERE id=?').run(name, email, avatar || null, passwordHash, crypto.randomUUID(), Date.now(), user.id);
    mirrorOwner(userById(user.id));
    if (req.body?.newPassword) db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').run(user.id, sha256(tokenFrom(req) || ''));
  });
  res.json({ user: safeUser(userById(user.id)) });
});
authRouter.get('/sessions', (req, res) => {
  const user = currentActor(req), currentHash = sha256(tokenFrom(req) || '');
  res.json({ rows: db.prepare('SELECT * FROM sessions WHERE user_id=? AND expires_at>? ORDER BY last_seen DESC').all(user.id, Date.now()).map(row => ({ id: row.public_id, current: row.token_hash === currentHash, createdAt: row.created_at, lastSeen: row.last_seen, expiresAt: row.expires_at, userAgent: row.user_agent })) });
});
authRouter.delete('/sessions/:id', (req, res) => {
  const user = currentActor(req), row = db.prepare('SELECT * FROM sessions WHERE public_id=? AND user_id=?').get(req.params.id, user.id);
  if (!row) throw error(404, 'Session not found.');
  db.prepare('DELETE FROM sessions WHERE public_id=? AND user_id=?').run(row.public_id, user.id);
  if (row.token_hash === sha256(tokenFrom(req) || '')) clearCookie(res);
  res.json({ ok: true });
});
const safeInvite = row => ({ id: row.id, name: row.name, email: row.email, role: row.role, createdAt: row.created_at, expiresAt: row.expires_at, status: row.accepted_at ? 'accepted' : row.revoked_at ? 'revoked' : row.expires_at <= Date.now() ? 'expired' : 'pending' });
function availableInvite(token) {
  const auth = configuredAuth();
  const row = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? db.prepare('SELECT * FROM workspace_invitations WHERE token_hash=?').get(sha256(token)) : null;
  const issuer = row && userById(row.invited_by);
  if (!auth || !row || row.workspace_owner !== auth.ownerId || row.accepted_at || row.revoked_at || row.expires_at <= Date.now()
    || !issuer?.active || !ROLE_PERMISSIONS[issuer.role]?.includes('manageTeam') || (row.role === 'owner' && issuer.role !== 'owner')) throw error(410, 'This invitation is expired or no longer available. Ask for a new invitation.', 'INVITE_UNAVAILABLE');
  return row;
}
authRouter.get('/team/invitations', (req, res) => {
  currentActor(req, 'manageTeam');
  res.json({ rows: db.prepare('SELECT * FROM workspace_invitations WHERE workspace_owner=? ORDER BY created_at DESC LIMIT 200').all(readAuth().ownerId).map(safeInvite) });
});
authRouter.post('/team/invitations', (req, res) => {
  const actor = currentActor(req, 'manageTeam'), email = cleanEmail(req.body?.email), name = req.body?.name?.trim() ? cleanName(req.body.name) : '', role = req.body?.role || 'member';
  if (!ROLES.includes(role) || (role === 'owner' && actor.role !== 'owner')) throw error(403, 'You cannot invite someone with that role.', 'AUTH_FORBIDDEN');
  assertUnique(name, email);
  const now = Date.now(), owner = readAuth().ownerId;
  if (db.prepare('SELECT 1 FROM workspace_invitations WHERE workspace_owner=? AND email=? COLLATE NOCASE AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>?').get(owner, email, now)) throw error(409, 'A pending invitation already exists. Revoke it before creating a replacement.');
  const token = crypto.randomBytes(32).toString('base64url'), id = crypto.randomUUID();
  db.prepare('INSERT INTO workspace_invitations(id,token_hash,name,email,role,invited_by,workspace_owner,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, sha256(token), name, email, role, actor.id, owner, now, now + 7 * DAY);
  res.status(201).json({ invitation: safeInvite(db.prepare('SELECT * FROM workspace_invitations WHERE id=?').get(id)), token });
});
authRouter.delete('/team/invitations/:id', (req, res) => {
  const actor = currentActor(req, 'manageTeam'), row = db.prepare('SELECT * FROM workspace_invitations WHERE id=? AND workspace_owner=?').get(req.params.id, readAuth().ownerId);
  if (!row) throw error(404, 'Invitation not found.');
  if (row.role === 'owner' && actor.role !== 'owner') throw error(403, 'Only an owner can revoke this invitation.');
  if (row.accepted_at) throw error(409, 'This invitation was accepted. Manage the team account instead.');
  db.prepare('UPDATE workspace_invitations SET revoked_at=? WHERE id=?').run(Date.now(), row.id); res.json({ ok: true });
});
authRouter.post('/invitation/lookup', (req, res) => { const row = availableInvite(req.body?.token); res.json({ invitation: safeInvite(row) }); });
authRouter.post('/invitation/accept', async (req, res) => {
  const before = availableInvite(req.body?.token), name = cleanName(req.body?.name || before.name), passwordHash = await hashPassword(checkPassword(req.body?.password));
  const row = availableInvite(req.body?.token); assertUnique(name, row.email);
  const id = crypto.randomUUID(), now = Date.now();
  tx(() => {
    db.prepare('INSERT INTO workspace_users(id,name,email,role,active,password_hash,revision,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,?)').run(id, name, row.email, row.role, passwordHash, crypto.randomUUID(), now, now);
    db.prepare('UPDATE workspace_invitations SET accepted_at=? WHERE id=?').run(now, row.id);
    startSession(req, res, id, true);
  });
  res.status(201).json({ user: safeUser(userById(id)) });
});
authRouter.use((err, req, res, next) => res.status(err.authSafe ? err.status : 500).json({ error: err.authSafe ? err.message : 'Workspace access could not be updated.', code: err.authSafe ? err.code : 'AUTH_ERROR' }));
