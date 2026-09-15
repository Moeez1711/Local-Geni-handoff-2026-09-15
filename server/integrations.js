import crypto from 'node:crypto';
import { db } from './db.js';
import { createEmailVault } from './emailVault.js';

import { INTEGRATIONS } from '../shared/integrations.js';
export { INTEGRATIONS };

db.exec(`CREATE TABLE IF NOT EXISTS integration_connections (
  id TEXT PRIMARY KEY, secret TEXT NOT NULL, revision TEXT NOT NULL,
  verified_at INTEGER, checked_at INTEGER, error TEXT NOT NULL DEFAULT '', metadata TEXT NOT NULL DEFAULT '{}'
)`);
export const integrationError = (status, message, code = 'INTEGRATION_FAILED') => Object.assign(new Error(message), { status, code, integrationSafe: true });
const catalog = id => {
  const found = INTEGRATIONS.find(item => item.id === id);
  if (!found) throw integrationError(404, 'Integration not found.');
  return found;
};
const string = (value, label, max = 2048) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw integrationError(400, `Enter a valid ${label.toLowerCase()}.`);
  return value.trim();
};
const credentialName = id => `integration:${id}`;
const TWILIO = 'https://api.twilio.com/2010-04-01/Accounts/';
export function createIntegrationService({ fetchFn = (...args) => globalThis.fetch(...args), vault = createEmailVault(), now = Date.now, simulated = false } = {}) {
  const row = id => db.prepare('SELECT * FROM integration_connections WHERE id=?').get(id);
  function status(id) {
    const item = catalog(id), saved = row(id);
    return { ...item, revision: saved?.revision || null, configured: Boolean(saved), verified: Boolean(saved?.verified_at), verifiedAt: saved?.verified_at || null, checkedAt: saved?.checked_at || null, error: saved?.error || '', metadata: saved ? JSON.parse(saved.metadata) : {}, simulated };
  }
  const credentials = id => { catalog(id); const saved = row(id); if (!saved) throw integrationError(409, 'Connect this integration first.'); return { ...vault.open(saved.secret, credentialName(id)), revision: saved.revision }; };
  function save(id, input = {}) {
    const item = catalog(id), previous = row(id);
    let existing = {};
    // A complete replacement can recover from an unavailable encryption key.
    if (previous && item.fields.some(field => !input[field.name]?.trim?.())) existing = credentials(id);
    const value = {};
    for (const field of item.fields) {
      const candidate = input[field.name] === '' || input[field.name] == null ? existing[field.name] : input[field.name];
      if (field.name === 'serviceAccount') {
        let parsed;
        try { parsed = typeof candidate === 'string' ? JSON.parse(candidate) : candidate; } catch { throw integrationError(400, 'Enter valid service account JSON.'); }
        if (parsed?.type !== 'service_account' || !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(parsed.client_email || '') || typeof parsed.private_key !== 'string' || parsed.private_key.length > 16000) throw integrationError(400, 'Use a Google service account key.');
        try { if (crypto.createPrivateKey(parsed.private_key).asymmetricKeyType !== 'rsa') throw new Error(); } catch { throw integrationError(400, 'The service account private key is invalid.'); }
        value.serviceAccount = { type: 'service_account', client_email: parsed.client_email, private_key: parsed.private_key };
      } else value[field.name] = string(candidate, field.label);
    }
    if (value.resourceId && !/^[\w-]{10,200}$/.test(value.resourceId)) throw integrationError(400, 'Paste the file ID from the Google URL.');
    if (value.fromNumber && !/^\+[1-9]\d{6,14}$/.test(value.fromNumber)) throw integrationError(400, 'Enter an international phone number starting with +.');
    if (id === 'twilio' && !/^AC[0-9a-f]{32}$/i.test(value.accountSid)) throw integrationError(400, 'Enter a valid Twilio Account SID.');
    db.prepare("INSERT INTO integration_connections(id,secret,revision) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,revision=excluded.revision,verified_at=NULL,checked_at=NULL,error='',metadata='{}'").run(id, vault.seal(value, credentialName(id)), crypto.randomUUID());
    return status(id);
  }
  async function request(url, options = {}) {
    let response;
    try { response = await fetchFn(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw integrationError(502, 'The provider could not be reached. Try again.'); }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw integrationError(response.status === 429 ? 429 : 400, response.status === 429 ? 'Provider rate limit reached. Try again later.' : response.status === 401 ? 'The provider rejected these credentials.' : response.status === 403 ? 'The account lacks permission. Check access and enabled APIs.' : response.status === 404 ? 'The account or file was not found. Check its ID and sharing permissions.' : 'The provider could not complete the check.');
    }
    try { return await response.json(); } catch { throw integrationError(502, 'The provider returned an unreadable response.'); }
  }
  async function googleToken(value, scope) {
    const timestamp = Math.floor(now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: value.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: timestamp, exp: timestamp + 3600 })}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), value.private_key).toString('base64url');
    const token = await request('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString() });
    if (typeof token.access_token !== 'string' || !token.access_token) throw integrationError(400, 'Google did not grant access. Check the service account.');
    return token.access_token;
  }
  async function check(id, value) {
    let data;
    if (id === 'openai') {
      data = await request('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${value.apiKey}` } });
      if (!Array.isArray(data.data) || !data.data.length) throw integrationError(400, 'No models are available to this key.');
    } else if (id === 'gemini') {
      data = await request('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', { headers: { 'x-goog-api-key': value.apiKey } });
      if (!data.models?.some(model => model.supportedGenerationMethods?.includes('generateContent'))) throw integrationError(400, 'No Gemini generation models are available.');
    } else if (id === 'telnyx') {
      data = await request(`https://api.telnyx.com/v2/phone_numbers?${new URLSearchParams({ 'filter[phone_number]': value.fromNumber })}`, { headers: { Authorization: `Bearer ${value.apiKey}` } });
      if (!data.data?.some(phone => phone.phone_number === value.fromNumber)) throw integrationError(400, 'Use a phone number owned by this Telnyx account.');
      return { fromNumber: value.fromNumber };
    } else if (id === 'vonage') {
      data = await request(`https://rest.nexmo.com/account/get-balance?${new URLSearchParams({ api_key: value.apiKey, api_secret: value.apiSecret })}`);
      if (typeof data.value !== 'number') throw integrationError(400, 'Vonage did not confirm account access.');
      return { fromNumber: value.fromNumber };
    } else if (id === 'neverbounce') {
      data = await request(`https://api.neverbounce.com/v4.2/account/info?${new URLSearchParams({ key: value.apiKey })}`);
      if (data.status !== 'success') throw integrationError(400, 'NeverBounce rejected this API key.');
    } else if (id === 'apollo') {
      data = await request('https://api.apollo.io/api/v1/auth/health', { headers: { 'x-api-key': value.apiKey } });
      if (data.is_logged_in !== true) throw integrationError(400, 'Apollo could not authenticate this key.');
    } else if (id === 'anthropic') {
      data = await request('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': value.apiKey, 'anthropic-version': '2023-06-01' } });
      if (!Array.isArray(data.data) || !data.data.length) throw integrationError(400, 'No Claude models are available to this key.');
    } else if (id === 'slack') {
      data = await request('https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: `Bearer ${value.apiKey}` } });
      if (data.ok !== true || !data.team_id) throw integrationError(400, 'Slack rejected this token. Check that the app is installed.');
    } else if (id === 'hubspot') {
      data = await request('https://api.hubapi.com/account-info/v3/details', { headers: { Authorization: `Bearer ${value.apiKey}` } });
      if (!data.portalId) throw integrationError(400, 'HubSpot did not return an account.');
    } else if (id === 'twilio') {
      const headers = { Authorization: `Basic ${Buffer.from(`${value.accountSid}:${value.authToken}`).toString('base64')}` };
      data = await request(`${TWILIO}${value.accountSid}.json`, { headers });
      if (data.sid !== value.accountSid || data.status !== 'active') throw integrationError(400, 'This Twilio account is not active.');
      const phones = await request(`${TWILIO}${value.accountSid}/IncomingPhoneNumbers.json?${new URLSearchParams({ PhoneNumber: value.fromNumber, PageSize: '20' })}`, { headers });
      if (!phones.incoming_phone_numbers?.some(phone => phone.phone_number === value.fromNumber && phone.capabilities?.sms === true)) throw integrationError(400, 'Use an SMS-capable phone number owned by this Twilio account.');
      return { fromNumber: value.fromNumber, accountType: data.type === 'Trial' ? 'Trial' : 'Full' };
    } else if (id === 'firecrawl') {
      data = await request('https://api.firecrawl.dev/v1/team/credit-usage', { headers: { Authorization: `Bearer ${value.apiKey}` } });
      if (data.success !== true && !data.data) throw integrationError(400, 'Firecrawl rejected this API key.');
      return { remainingCredits: data.data?.remaining_credits ?? null };
    } else {
      const scope = id === 'google-docs' ? 'documents.readonly' : id === 'google-sheets' ? 'spreadsheets.readonly' : 'drive.metadata.readonly';
      const token = await googleToken(value.serviceAccount, `https://www.googleapis.com/auth/${scope}`);
      const url = id === 'google-docs' ? `https://docs.googleapis.com/v1/documents/${value.resourceId}?fields=documentId` : id === 'google-sheets' ? `https://sheets.googleapis.com/v4/spreadsheets/${value.resourceId}?fields=spreadsheetId` : 'https://www.googleapis.com/drive/v3/about?fields=user(permissionId)';
      data = await request(url, { headers: { Authorization: `Bearer ${token}` } });
      if (id === 'google-docs' ? data.documentId !== value.resourceId : id === 'google-sheets' ? data.spreadsheetId !== value.resourceId : !data.user?.permissionId) throw integrationError(400, 'Google did not confirm access.');
    }
    return {};
  }
  async function verify(id) {
    const value = credentials(id);
    try {
      const metadata = await check(id, value);
      const result = db.prepare("UPDATE integration_connections SET verified_at=?,checked_at=?,error='',metadata=? WHERE id=? AND revision=?").run(now(), now(), JSON.stringify(metadata), id, value.revision);
      if (!result.changes) throw integrationError(409, 'The connection changed during verification. Check it again.');
      return status(id);
    } catch (err) {
      const message = err.integrationSafe ? err.message : 'This connection could not be checked.';
      db.prepare('UPDATE integration_connections SET verified_at=NULL,checked_at=?,error=? WHERE id=? AND revision=?').run(now(), message, id, value.revision);
      throw integrationError(err.integrationSafe ? err.status : 500, message);
    }
  }
  return { list: () => ({ rows: INTEGRATIONS.map(item => status(item.id)), simulated }), status, save, verify, credentials,
    disconnect(id) { catalog(id); db.prepare('DELETE FROM integration_connections WHERE id=?').run(id); return status(id); } };
}
export const integrationService = createIntegrationService();
