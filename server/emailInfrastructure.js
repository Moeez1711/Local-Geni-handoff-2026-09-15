import { Resolver } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { generateKeyPair, createPublicKey, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { db, json } from './db.js';
import { getPrivateSecret, setPrivateSecret, deletePrivateSecret } from './emailVault.js';
import { normalizeEmail, emailError } from './emailPolicy.js';

db.exec(`CREATE TABLE IF NOT EXISTS email_infrastructure (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
const read = (key, fallback = null) => json(db.prepare('SELECT value FROM email_infrastructure WHERE key=?').get(key)?.value, fallback);
const write = (key, value) => db.prepare('INSERT INTO email_infrastructure VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
const resolver = new Resolver({ timeout: 3000, tries: 1 });
const pair = promisify(generateKeyPair);
const defaults = { domain: '', selector: 'localgeni', provider: 'gmail', spfInclude: '', dmarcPolicy: 'none', reportAddress: '' };
const hasVerifier = () => Boolean(db.prepare("SELECT 1 FROM email_private_secrets WHERE name='zerobounce'").get());
const tag = (value, name) => String(value).split(';').map((part) => part.trim()).find((part) => part.toLowerCase().startsWith(`${name}=`))?.split('=').slice(1).join('=').trim() || '';
export function cleanDomain(value) {
  const domain = domainToASCII(String(value || '').trim().toLowerCase());
  if (domain.length > 253 || !/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) || /\.(?:localhost|local|internal|test|invalid)$/.test(domain)) throw emailError(400, 'INVALID_DOMAIN', 'Enter a public domain without https:// or a path.');
  return domain;
}
function cleanSelector(value) {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/i.test(value)) throw emailError(400, 'INVALID_SELECTOR', 'Use a DKIM selector with letters, numbers, hyphens, or underscores.');
  return value.toLowerCase();
}
function cleanSpfInclude(value) {
  const name = domainToASCII(String(value || '').trim().toLowerCase());
  if (name.length > 253 || !/^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z]{2,63}$/.test(name)) throw emailError(400,'INVALID_SPF_INCLUDE','Enter the include domain supplied by your email provider.');
  return name;
}
export function getInfrastructureSettings() {
  const config = { ...defaults, ...read('config', {}) };
  const dkim = read('dkim');
  return { ...config, dkim: dkim ? { domain: dkim.domain, selector: dkim.selector, publicRecord: dkim.publicRecord, enabled: dkim.enabled, verifiedAt: dkim.verifiedAt, createdAt: dkim.createdAt } : null, verifierConfigured: hasVerifier() };
}
export function saveInfrastructureSettings(body = {}) {
  const next = { ...defaults, ...read('config', {}) };
  if (body.domain !== undefined) next.domain = cleanDomain(body.domain);
  if (body.selector !== undefined) next.selector = cleanSelector(body.selector);
  if (body.provider !== undefined) { if (!['gmail','microsoft','smtp'].includes(body.provider)) throw emailError(400,'INVALID_PROVIDER','Choose a sending provider.'); next.provider = body.provider; }
  if (body.spfInclude !== undefined) { if (typeof body.spfInclude !== 'string') throw emailError(400,'INVALID_SPF_INCLUDE','Enter the include domain supplied by your email provider.'); next.spfInclude = body.spfInclude.trim() ? cleanSpfInclude(body.spfInclude) : ''; }
  if (body.dmarcPolicy !== undefined) { if (!['none','quarantine','reject'].includes(body.dmarcPolicy)) throw emailError(400,'INVALID_DMARC','Choose a valid DMARC policy.'); next.dmarcPolicy = body.dmarcPolicy; }
  if (body.reportAddress !== undefined) next.reportAddress = body.reportAddress.trim() ? normalizeEmail(body.reportAddress) : '';
  write('config', next);
  return getInfrastructureSettings();
}
async function lookup(method, name, dns = resolver) {
  try { return { state: 'found', records: await dns[method](name) }; }
  catch (error) { return { state: ['ENODATA','ENOTFOUND'].includes(error.code) ? 'missing' : 'unknown', records: [], code: error.code === 'ENOTFOUND' ? 'NXDOMAIN' : error.code === 'ENODATA' ? 'NO_RECORD' : 'DNS_UNAVAILABLE' }; }
}
export async function checkDomain(body = {}, { dns = resolver } = {}) {
  const config = { ...defaults, ...read('config', {}), ...body };
  const domain = cleanDomain(config.domain);
  const selector = config.selector ? cleanSelector(config.selector) : '';
  const [mx, rootTxt, dmarcTxt, dkimTxt] = await Promise.all([
    lookup('resolveMx', domain, dns), lookup('resolveTxt', domain, dns), lookup('resolveTxt', `_dmarc.${domain}`, dns),
    selector ? lookup('resolveTxt', `${selector}._domainkey.${domain}`, dns) : { state: 'not_checked', records: [] },
  ]);
  const spf = rootTxt.records.map((chunks) => chunks.join('')).filter((record) => /^v=spf1(?:\s|$)/i.test(record));
  const dmarc = dmarcTxt.records.map((chunks) => chunks.join('')).filter((record) => /^v=DMARC1(?:;|$)/i.test(record));
  const dkim = dkimTxt.records.map((chunks) => chunks.join('')).filter((record) => /(?:^|;)\s*p=/i.test(record));
  const generated = read('dkim');
  const matchingKey = generated?.domain === domain && generated?.selector === selector ? tag(generated.publicRecord, 'p') : null;
  const spfIssue = spf.length > 1 ? 'Multiple SPF records conflict. Merge authorized senders into one record.' : spf[0] && /(?:^|\s)\+?all(?:\s|$)/i.test(spf[0]) ? 'This record allows any sender. Review the all mechanism.' : null;
  const algorithm = tag(dkim[0], 'k') || 'rsa';
  const keyText = tag(dkim[0], 'p');
  const dkimTags = (dkim[0] || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => part.split('=')[0].toLowerCase());
  let dkimValid = dkim.length === 1 && new Set(dkimTags).size === dkimTags.length && (!tag(dkim[0],'v') || tag(dkim[0],'v') === 'DKIM1') && /^[A-Za-z0-9+/]+={0,2}$/.test(keyText) && ['rsa','ed25519'].includes(algorithm);
  if (dkimValid && algorithm === 'rsa') { try { const key = createPublicKey({ key: Buffer.from(keyText, 'base64'), type: 'spki', format: 'der' }); dkimValid = key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 1024; } catch { dkimValid = false; } }
  if (dkimValid && algorithm === 'ed25519') dkimValid = !matchingKey && Buffer.from(keyText, 'base64').length === 32;
  if (matchingKey && tag(dkim[0], 'p') !== matchingKey) dkimValid = false;
  const dmarcTags = (dmarc[0] || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => part.split('=')[0].toLowerCase());
  const dmarcValid = dmarc.length === 1 && ['none','quarantine','reject'].includes(tag(dmarc[0], 'p')) && new Set(dmarcTags).size === dmarcTags.length;
  const isNullMx = mx.records.some((record) => record.exchange === '' || record.exchange === '.');
  const checks = [
    { key: 'mx', label: 'Inbound mail (MX)', status: mx.state === 'unknown' ? 'unknown' : isNullMx ? 'issue' : mx.records.length ? 'found' : 'missing', detail: isNullMx ? 'This domain declares that it does not accept email.' : mx.records.length ? 'Mail routing records found. This does not verify an individual mailbox.' : 'No MX record found; some domains use address-record fallback.', records: mx.records.map((r) => `${r.priority} ${r.exchange}`) },
    { key: 'spf', label: 'SPF', status: rootTxt.state === 'unknown' ? 'unknown' : spfIssue ? 'issue' : spf.length === 1 ? 'found' : 'missing', detail: spfIssue || (spf.length ? 'One SPF record found. Authorization, recursive lookup limits, and alignment still depend on your sending provider.' : 'No SPF record found at this exact domain.'), records: spf },
    { key: 'dkim', label: 'DKIM', status: !selector ? 'not_checked' : dkimTxt.state === 'unknown' ? 'unknown' : dkimValid ? 'found' : dkim.length ? 'issue' : 'missing', detail: !selector ? 'Enter the selector provided by your email service.' : dkimValid ? 'A public key was found for this selector. An actual received message is needed to confirm signing and alignment.' : matchingKey ? 'The published key must match the Local Geni key before signing can be enabled.' : 'No usable public key found for this selector. Check your provider’s DKIM setup.', records: dkim },
    { key: 'dmarc', label: 'DMARC', status: dmarcTxt.state === 'unknown' ? 'unknown' : dmarc.length && !dmarcValid ? 'issue' : dmarcValid ? 'found' : 'missing', detail: dmarcValid ? `Published policy: ${tag(dmarc[0], 'p')}. A record alone does not prove messages pass DMARC.` : dmarc.length ? 'Conflicting, duplicate, or invalid DMARC tags need review.' : 'Check the exact domain. An organizational-domain fallback may also apply.', records: dmarc },
  ];
  const result = { domain, selector, checkedAt: Date.now(), checks, note: 'DNS posture check only. No test email was sent, and inbox placement has not been measured.' };
  write(`audit:${domain}:${selector}`, result);
  return result;
}
export function buildDnsPlan() {
  const c = getInfrastructureSettings();
  const domain = cleanDomain(c.domain);
  const audit = read(`audit:${domain}:${c.selector}`);
  const existing = audit?.checks.find((check) => check.key === 'spf')?.records || [];
  const include = c.provider === 'gmail' ? '_spf.google.com' : c.provider === 'microsoft' ? 'spf.protection.outlook.com' : c.spfInclude;
  const records = [];
  if (include) {
    let value = `v=spf1 include:${include} ~all`;
    if (existing.length === 1) {
      value = existing[0];
      if (!value.split(/\s+/).includes(`include:${include}`)) {
        const parts = value.split(/\s+/); const end = parts.findIndex((p) => /^[+?~-]?all$/i.test(p) || /^redirect=/i.test(p));
        parts.splice(end < 0 ? parts.length : end, 0, `include:${include}`); value = parts.join(' ');
      }
    }
    records.push({ type: 'TXT', name: domain, value: existing.length > 1 ? '' : value, note: existing.length > 1 ? 'Resolve the conflicting SPF records before publishing.' : existing.length ? 'Update the existing SPF record. Preserve every legitimate sender.' : 'Add only if no SPF record already exists. Recheck DNS immediately before publishing.' });
  }
  records.push({ type: 'TXT', name: `_dmarc.${domain}`, value: `v=DMARC1; p=${c.dmarcPolicy};${c.reportAddress ? ` rua=mailto:${c.reportAddress};` : ''}`, note: 'Review existing policy before replacing it. Start with monitoring while you identify legitimate senders. External report addresses may require DNS authorization.' });
  if (c.provider === 'smtp' && c.dkim?.domain === domain) records.push({ type:'TXT',name:`${c.dkim.selector}._domainkey.${domain}`,value:c.dkim.publicRecord,note:'Publish this public key, then enable signing after the DNS check passes. Keep the private key on this Mac.' });
  return { domain, records, providerManagedDkim: c.provider !== 'smtp', note: 'These are drafts. They do not change DNS. Gmail and Microsoft domain signing must also be enabled by your mailbox administrator.' };
}
export async function generateDkim(body = {}) {
  const domain = cleanDomain(body.domain); const selector = cleanSelector(body.selector || 'localgeni');
  const current = read('dkim');
  if (current?.enabled) throw emailError(409, 'DKIM_ACTIVE', 'Disable current signing before generating a replacement key.');
  const keys = await pair('rsa', { modulusLength: 2048, publicKeyEncoding: { type:'spki',format:'der' },privateKeyEncoding:{type:'pkcs8',format:'pem'} });
  if (JSON.stringify(read('dkim')) !== JSON.stringify(current)) throw emailError(409,'DKIM_CHANGED','The signing setup changed during key generation. Review it before replacing the key.');
  setPrivateSecret('dkim-private', keys.privateKey);
  write('dkim',{domain,selector,publicRecord:`v=DKIM1; k=rsa; p=${keys.publicKey.toString('base64')}`,enabled:false,verifiedAt:null,createdAt:Date.now(),revision:randomUUID()});
  return getInfrastructureSettings();
}
export async function setDkimEnabled(enabled, options = {}) {
  if (typeof enabled !== 'boolean') throw emailError(400,'INVALID_DKIM','Choose whether to enable signing.');
  const dkim = read('dkim');
  if (!dkim) throw emailError(409,'DKIM_NOT_CONFIGURED','Generate a DKIM key first.');
  if (enabled) {
    const audit = await checkDomain({domain:dkim.domain,selector:dkim.selector}, options);
    if (audit.checks.find((c) => c.key === 'dkim').status !== 'found') throw emailError(409,'DKIM_DNS_MISMATCH','Publish the matching DKIM public key in DNS before enabling signing.');
    if (JSON.stringify(read('dkim')) !== JSON.stringify(dkim)) throw emailError(409,'DKIM_CHANGED','The signing setup changed while checking DNS. Review the current setting.');
  }
  write('dkim',{...dkim,enabled,verifiedAt:enabled?Date.now():null,revision:randomUUID()}); return getInfrastructureSettings();
}
export async function getDkimSigningConfig(fromEmail) {
  const dkim = read('dkim');
  if (!dkim?.enabled) return null;
  if (normalizeEmail(fromEmail).split('@')[1] !== dkim.domain) throw emailError(409,'DKIM_DOMAIN_MISMATCH','The active DKIM key belongs to another sender domain. Update domain signing first.');
  if (Date.now() - dkim.verifiedAt > 3600000) await setDkimEnabled(true);
  const privateKey = getPrivateSecret('dkim-private');
  if (!privateKey) throw emailError(409,'DKIM_KEY_UNAVAILABLE','The signing key is unavailable. Reconfigure DKIM before sending.');
  return { domainName:dkim.domain,keySelector:dkim.selector,privateKey };
}
export function setVerifier({apiKey,disconnect=false}={}) {
  if (disconnect) deletePrivateSecret('zerobounce');
  else {
    if (typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(apiKey.trim())) throw emailError(400,'INVALID_VERIFIER_KEY','Enter your ZeroBounce API key.');
    setPrivateSecret('zerobounce',apiKey.trim());
  }
  return { configured:hasVerifier() };
}
export async function verifyRecipient({email,mode='dns',force=false}={}, {dns=resolver,fetchImpl=fetch}={}) {
  email = normalizeEmail(email);
  if (!['dns','mailbox'].includes(mode)) throw emailError(400,'INVALID_VERIFICATION','Choose a domain or mailbox check.');
  const cached = db.prepare('SELECT result,checked_at FROM email_verifications WHERE email=?').get(email);
  const prior = cached ? json(cached.result) : null;
  if (!force && prior?.mode === mode && Date.now()-cached.checked_at < 86400000) return {...prior,cached:true};
  let result;
  if (mode === 'dns') {
    const domain = email.split('@')[1]; const mx = await lookup('resolveMx',domain,dns);
    const nullMx = mx.records.some((r) => !r.exchange || r.exchange === '.');
    let status = nullMx || mx.code === 'NXDOMAIN' ? 'invalid' : mx.records.length ? 'domain_valid' : 'unknown';
    let fallback = null;
    if (mx.code === 'NO_RECORD') {
      const records = await Promise.all([lookup('resolve4',domain,dns),lookup('resolve6',domain,dns)]);
      fallback = records.some((r) => r.records.length);
      status = fallback ? 'domain_valid' : records.some((r) => r.state === 'unknown') ? 'unknown' : 'invalid';
    }
    result = {email,mode,status,summary:status==='invalid'?'This domain cannot receive email.':status==='domain_valid'?'The domain has a mail route. This mailbox has not been verified.':'DNS could not establish a mail route. Try again later.',checks:[{label:'Mail routing',status,detail:fallback?'Address-record fallback found.':mx.records.map((r)=>r.exchange).join(', ')||'No MX record found.'},{label:'Individual mailbox',status:'not_checked',detail:'A domain check does not establish whether this address exists.'}],checkedAt:Date.now()};
  } else {
    const key = getPrivateSecret('zerobounce');
    if (!key) throw emailError(409,'VERIFIER_NOT_CONFIGURED','Connect ZeroBounce in Email settings for individual mailbox checks.');
    let data;
    try {
      const url = new URL('https://api.zerobounce.net/v2/validate'); url.searchParams.set('api_key',key);url.searchParams.set('email',email);url.searchParams.set('ip_address','');
      const response = await fetchImpl(url,{signal:AbortSignal.timeout(18000),redirect:'error'});
      if (!response.ok) throw new Error('provider'); data=await response.json();
      if (data.error || data.errors || !data.status || normalizeEmail(data.address)!==email) throw new Error('provider');
    } catch { throw emailError(502,'VERIFICATION_UNAVAILABLE','The verification provider could not complete this check. Check your key, credits, and connection.'); }
    const status = data.status==='valid'?'deliverable':data.status==='invalid'?'invalid':['catch-all','spamtrap','abuse','do_not_mail'].includes(data.status)?'risky':'unknown';
    result={email,mode,status,provider:'ZeroBounce',providerStatus:String(data.status).slice(0,50),summary:status==='deliverable'?'The provider reports this mailbox as deliverable. Delivery is not guaranteed.':status==='invalid'?'The provider reports this address as invalid.':status==='risky'?'The provider flagged this address as risky. Review it before outreach.':'The provider could not determine whether this mailbox accepts mail.',checks:[{label:'Mailbox provider result',status,detail:String(data.sub_status||data.status).slice(0,100)},{label:'Catch-all / role address',status:'info',detail:`Catch-all: ${data.status==='catch-all'?'yes':'not reported'}. Role address: ${data.sub_status==='role_based'?'yes':'not reported'}.`}],checkedAt:Date.now()};
  }
  // A DNS-only check must never erase a recent mailbox verdict.
  const latest = db.prepare('SELECT result,checked_at FROM email_verifications WHERE email=?').get(email);
  const latestResult = latest ? json(latest.result) : null;
  if (!(mode==='dns' && latestResult?.mode==='mailbox' && Date.now()-latest.checked_at < 30*86400000)) db.prepare('INSERT INTO email_verifications VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET result=excluded.result,checked_at=excluded.checked_at').run(email,JSON.stringify(result),result.checkedAt);
  return result;
}
