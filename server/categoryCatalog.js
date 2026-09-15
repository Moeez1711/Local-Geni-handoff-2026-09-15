import crypto from 'node:crypto';
import { db } from './db.js';
import { getPrivateSecret, setPrivateSecret, deletePrivateSecret } from './emailVault.js';
import { categories, countries, categorySnapshot } from './catalog.js';
import { mergeCategoryRows } from '../shared/categorySearch.js';
import { isAllowedHost } from './config.js';

const SECRET = 'google-category-catalog';
const DAY = 86400000;
export const CATEGORY_SCOPE = 'https://www.googleapis.com/auth/business.manage';
export const CATEGORY_CALLBACK = '/oauth/google-categories';
const fail = (status, message) => Object.assign(new Error(message), { status });
const tokenString = value => typeof value === 'string' && value.length > 0 && value.length < 16000 && !/[\r\n]/.test(value);
export function categoryLocale(country = 'US', language = 'en') {
  country = String(country).toUpperCase();
  if (!countries.some(row => row.code === country)) throw fail(400, 'Choose a supported country.');
  if (typeof language !== 'string' || language.length > 35) throw fail(400, 'Enter a valid language code.');
  try { language = Intl.getCanonicalLocales(language)[0]; } catch { throw fail(400, 'Enter a valid language code, such as en, ar, or pt-BR.'); }
  if (!language) throw fail(400, 'Choose a language.');
  return { country, language, key: `${country}:${language}` };
}

export function createCategoryCatalog({ database = db, fetchFn = (...args) => fetch(...args), now = Date.now,
  vault = { get: getPrivateSecret, set: setPrivateSecret, delete: deletePrivateSecret }, simulated = false } = {}) {
  database.exec(`CREATE TABLE IF NOT EXISTS category_catalog_locales (
    locale TEXT PRIMARY KEY, country TEXT NOT NULL, language TEXT NOT NULL,
    rows TEXT NOT NULL DEFAULT '[]', updated_at INTEGER, attempted_at INTEGER, error TEXT
  ); CREATE TABLE IF NOT EXISTS category_catalog_options (id INTEGER PRIMARY KEY CHECK(id=1), auto_refresh INTEGER NOT NULL DEFAULT 0);
  INSERT OR IGNORE INTO category_catalog_options(id) VALUES(1);`);
  let revision = crypto.randomUUID(), timer = null, running = false;
  const pending = new Map();
  const read = () => vault.get(SECRET) || {};
  const options = () => database.prepare('SELECT auto_refresh FROM category_catalog_options WHERE id=1').get();
  const assertRevision = snapshot => { if (snapshot !== revision) throw fail(409, 'The category connection changed. Try again.'); };
  const snapshotRows = locale => {
    try { return JSON.parse(database.prepare('SELECT rows FROM category_catalog_locales WHERE locale=?').get(locale)?.rows || '[]'); } catch { return []; }
  };
  function status() {
    const settings = read();
    const locales = database.prepare('SELECT locale,country,language,updated_at AS updatedAt,attempted_at AS attemptedAt,error FROM category_catalog_locales ORDER BY country,language').all()
      .map(row => ({ ...row, count: snapshotRows(row.locale).length }));
    return { configured: Boolean(settings.clientId && settings.clientSecret), connected: Boolean(settings.refreshToken),
      clientId: settings.clientId || '', connectedAt: settings.connectedAt || null, autoRefresh: Boolean(options().auto_refresh),
      refreshDays: 30, locales, bundled: categorySnapshot, simulated, refreshing: running };
  }
  function list(country, language, all = false) {
    const locale = categoryLocale(country, language);
    const current = snapshotRows(locale.key);
    const others = all ? database.prepare('SELECT locale FROM category_catalog_locales WHERE locale!=? ORDER BY locale').all(locale.key).flatMap(row => snapshotRows(row.locale)) : [];
    const rows = mergeCategoryRows(categories, [...current, ...others]);
    const updatedAt = database.prepare('SELECT updated_at FROM category_catalog_locales WHERE locale=?').get(locale.key)?.updated_at || null;
    return { rows, country: locale.country, language: locale.language, updatedAt, googleCount: new Set([...current, ...others].map(row => row.id)).size, bundledCount: categories.length, source: current.length || others.length ? 'google-and-bundled' : 'bundled' };
  }
  function resolve(id, country, language) {
    const bundled = categories.find(row => row.id === id);
    if (bundled) return bundled;
    if (typeof id !== 'string' || !id.startsWith('gbp:')) return null;
    const locale = categoryLocale(country, language || 'en');
    return snapshotRows(locale.key).find(row => row.id === id) || database.prepare('SELECT locale FROM category_catalog_locales ORDER BY locale').all().flatMap(row => snapshotRows(row.locale)).find(row => row.id === id) || null;
  }
  function configure({ clientId, clientSecret }) {
    if (simulated) throw fail(409, 'Google connections are disabled in the sample workspace.');
    clientId = String(clientId || '').trim(); clientSecret = String(clientSecret || '').trim();
    const previous = read();
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId) || clientId.length > 300) throw fail(400, 'Enter your Google OAuth client ID.');
    if (!clientSecret && clientId === previous.clientId) clientSecret = previous.clientSecret;
    if (!tokenString(clientSecret)) throw fail(400, 'Enter your Google OAuth client secret.');
    if (clientId === previous.clientId && clientSecret === previous.clientSecret) return status();
    vault.set(SECRET, { clientId, clientSecret });
    revision = crypto.randomUUID(); pending.clear();
    database.prepare('UPDATE category_catalog_options SET auto_refresh=0 WHERE id=1').run();
    return status();
  }
  function begin({ origin, binding }) {
    if (simulated) throw fail(409, 'Google connections are disabled in the sample workspace.');
    const settings = read();
    if (!settings.clientId || !settings.clientSecret) throw fail(409, 'Save your Google OAuth client first.');
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || !isAllowedHost(parsed.hostname) || parsed.origin !== origin) throw fail(400, 'Connect from the local app.');
    for (const [key, value] of pending) if (value.expires < now() || value.binding === binding) pending.delete(key);
    if (pending.size >= 20) throw fail(429, 'Finish an existing Google connection first.');
    const state = crypto.randomBytes(32).toString('base64url'), verifier = crypto.randomBytes(48).toString('base64url');
    const redirectUri = `${origin}${CATEGORY_CALLBACK}`;
    pending.set(state, { binding, verifier, redirectUri, origin, revision, expires: now() + 10 * 60000 });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: settings.clientId, redirect_uri: redirectUri, response_type: 'code', scope: CATEGORY_SCOPE,
      access_type: 'offline', prompt: 'consent', state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    return { url: url.href, state };
  }
  async function googleJson(url, init, kind) {
    let response, data;
    try {
      response = await fetchFn(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30000) });
      data = await response.json();
    } catch { throw fail(502, 'Google could not be reached. Your saved categories are unchanged.'); }
    if (!response.ok) {
      const message = response.status === 429 ? 'Google’s category quota was reached. Try again later.'
        : response.status === 403 ? 'Enable the Business Profile Business Information API in an approved Google project, then retry.'
        : kind === 'token' || response.status === 401 ? 'Google authorization expired or was declined. Connect Google again.'
        : 'Google could not refresh the catalogue. Your saved categories are unchanged.';
      throw fail(502, message);
    }
    return data;
  }
  async function complete({ state, code, binding, assertCurrent = () => {} }) {
    if (typeof state !== 'string' || state.length > 100) throw fail(400, 'Start the Google connection again.');
    const flow = pending.get(state);
    if (!flow || flow.binding !== binding || flow.expires < now() || flow.revision !== revision) throw fail(400, 'This Google connection has expired. Start again.');
    pending.delete(state); // a code/state pair can be consumed only once, including failed exchanges
    if (!tokenString(code)) throw fail(400, 'Google did not return an authorization code.');
    const settings = read();
    const data = await googleJson('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
      client_id: settings.clientId, client_secret: settings.clientSecret, code, code_verifier: flow.verifier,
      redirect_uri: flow.redirectUri, grant_type: 'authorization_code' }) }, 'token');
    assertCurrent(); assertRevision(flow.revision);
    if (!tokenString(data.refresh_token) || !String(data.scope || '').split(' ').includes(CATEGORY_SCOPE)) throw fail(409, 'Grant Business Profile access to enable category refresh.');
    vault.set(SECRET, { ...settings, refreshToken: data.refresh_token, connectedAt: now() });
    revision = crypto.randomUUID(); pending.clear();
    return status();
  }
  async function refresh({ country, language, assertCurrent = () => {} }) {
    const locale = categoryLocale(country, language), snapshot = revision, settings = read();
    if (simulated) throw fail(409, 'Google refresh is disabled in the sample workspace.');
    if (!settings.refreshToken) throw fail(409, 'Connect Google to import its category catalogue.');
    if (running) throw fail(409, 'A category refresh is already running.');
    running = true;
    database.prepare('INSERT INTO category_catalog_locales(locale,country,language,attempted_at) VALUES(?,?,?,?) ON CONFLICT(locale) DO UPDATE SET attempted_at=excluded.attempted_at').run(locale.key, locale.country, locale.language, now());
    try {
      const token = await googleJson('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: settings.clientId, client_secret: settings.clientSecret, refresh_token: settings.refreshToken, grant_type: 'refresh_token' }) }, 'token');
      assertCurrent(); assertRevision(snapshot);
      if (!tokenString(token.access_token)) throw fail(502, 'Google did not return a valid access token.');
      const rows = new Map(), tokens = new Set(); let pageToken = '';
      do {
        if (tokens.has(pageToken) || tokens.size >= 300) throw fail(502, 'Google returned an incomplete category catalogue. Retry the refresh.');
        tokens.add(pageToken);
        const url = new URL('https://mybusinessbusinessinformation.googleapis.com/v1/categories');
        url.search = new URLSearchParams({ regionCode: locale.country, languageCode: locale.language, view: 'BASIC', pageSize: '100', ...(pageToken ? { pageToken } : {}) });
        const page = await googleJson(url.href, { headers: { Authorization: `Bearer ${token.access_token}` } }, 'categories');
        assertCurrent(); assertRevision(snapshot);
        if (!Array.isArray(page.categories)) throw fail(502, 'Google returned an incomplete category catalogue.');
        for (const row of page.categories) {
          if (typeof row.name !== 'string' || row.name.length > 250 || !/^[\w:/.-]+$/.test(row.name) || typeof row.displayName !== 'string' || !row.displayName.trim() || row.displayName.length > 300) throw fail(502, 'Google returned an invalid category. Your saved categories are unchanged.');
          const id = `gbp:${row.name}`;
          rows.set(id, { id, googleId: row.name, label: row.displayName.trim(), query: row.displayName.trim(), value: 'medium', group: 'Google categories', source: 'google', language: locale.language });
        }
        pageToken = page.nextPageToken || '';
        if (typeof pageToken !== 'string' || pageToken.length > 4000) throw fail(502, 'Google returned an invalid page token.');
      } while (pageToken);
      if (!rows.size) throw fail(502, 'Google returned no categories for this country and language. Try another language.');
      assertCurrent(); assertRevision(snapshot);
      // Replace only after every page succeeded. Failed refreshes retain the last usable snapshot.
      database.prepare('UPDATE category_catalog_locales SET rows=?,updated_at=?,error=NULL WHERE locale=?').run(JSON.stringify([...rows.values()]), now(), locale.key);
      return { ...list(locale.country, locale.language), status: status() };
    } catch (error) {
      if (snapshot === revision) database.prepare('UPDATE category_catalog_locales SET error=? WHERE locale=?').run(error.status ? error.message : 'Refresh failed. Try again.', locale.key);
      throw error;
    } finally { running = false; }
  }
  async function refreshDue() {
    if (running || simulated || !options().auto_refresh || !read().refreshToken) return;
    for (const row of database.prepare('SELECT * FROM category_catalog_locales ORDER BY attempted_at').all()) {
      if (!options().auto_refresh || !read().refreshToken) break;
      if ((!row.updated_at || now() - row.updated_at >= 30 * DAY) && (!row.attempted_at || now() - row.attempted_at >= DAY)) {
        try { await refresh({ country: row.country, language: row.language }); } catch { /* retained snapshot and safe error are shown in settings */ }
      }
    }
  }
  return { status, list, resolve, configure, begin, complete, refresh, refreshDue,
    setAuto(enabled) {
      if (typeof enabled !== 'boolean') throw fail(400, 'Choose whether automatic refresh is enabled.');
      if (enabled && !read().refreshToken) throw fail(409, 'Connect Google first.');
      database.prepare('UPDATE category_catalog_options SET auto_refresh=? WHERE id=1').run(Number(enabled)); return status();
    },
    disconnect() { revision = crypto.randomUUID(); pending.clear(); vault.delete(SECRET); database.prepare('UPDATE category_catalog_options SET auto_refresh=0 WHERE id=1').run(); return status(); },
    startWorker() { if (!timer) { timer = setInterval(() => { refreshDue().catch(() => {}); }, 3600000); timer.unref(); refreshDue().catch(() => {}); } },
    stopWorker() { clearInterval(timer); timer = null; revision = crypto.randomUUID(); pending.clear(); },
  };
}

export const categoryCatalog = createCategoryCatalog();
