/** Dedicated isolated QA simulator. This script cannot deliver messages or contact providers. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createWhatsAppQaProvider, WHATSAPP_QA_ACCOUNT, WHATSAPP_QA_NUMBERS, WHATSAPP_QA_TEMPLATE } from './whatsapp-qa-provider.mjs';
import { createIntegrationsQaProvider } from './integrations-qa-provider.mjs';
import { buildSearchPlan, radiusBounds } from '../shared/searchPlan.js';

const qaPort = Number(process.env.LOCAL_GENI_QA_PORT || 4011);
if (![4011, 4013].includes(qaPort)) throw new Error('Use dedicated QA port 4011 or 4013.');
const existingFixture = process.env.LOCAL_GENI_QA_FIXTURE;
if (existingFixture && (!/^local-geni-email-qa-[\w-]+$/.test(path.basename(existingFixture)) || fs.realpathSync(path.dirname(existingFixture)) !== fs.realpathSync(os.tmpdir()) || !fs.existsSync(path.join(existingFixture, 'fixture.db')))) throw new Error('Reuse only an existing isolated QA fixture.');
const fixtureDir = existingFixture || fs.mkdtempSync(path.join(os.tmpdir(), 'local-geni-email-qa-'));
process.env.DB_PATH = path.join(fixtureDir, 'fixture.db');
process.env.EMAIL_KEY_PATH = path.join(fixtureDir, 'email.key');
process.env.PORT = String(qaPort);
process.env.WEBSITE_CONCURRENCY = '0';
process.env.GOOGLE_PLACES_API_KEY = '';
process.env.LOCAL_GENI_QA_ISOLATED = '1';
globalThis.fetch = async () => { throw new Error('External network disabled in the email QA simulator'); };

const { db } = await import('../server/db.js');
const { createInboxService } = await import('../server/emailInbox.js');
const { createCampaignService } = await import('../server/emailCampaigns.js');
const { simpleParser } = await import('mailparser');
const { createEmailService } = await import('../server/emailService.js');
const { createEmailRouter, requireLocalEmailOrigin } = await import('../server/routes/email.js');
const { default: infrastructureRouter } = await import('../server/routes/emailInfrastructure.js');
const infra = await import('../server/emailInfrastructure.js');
const { default: previews } = await import('../server/routes/previews.js');
const { default: previewFiles } = await import('../server/routes/previewFiles.js');
const { previewFileService } = await import('../server/previewFiles.js');
const { savePreview } = await import('../server/previewRepo.js');
const { createWhatsAppService } = await import('../server/whatsappService.js');
const { createWhatsAppRouter } = await import('../server/routes/whatsapp.js');
const { default: api } = await import('../server/routes/api.js');
const { default: crmRouter } = await import('../server/routes/crm.js');
const { default: listsRouter } = await import('../server/routes/lists.js');
const { default: customFieldsRouter } = await import('../server/routes/customFields.js');
const { requireAuth } = await import('../server/auth.js');
const { ROOT } = await import('../server/config.js');
const { categories, countries, WHATSAPP_FIRST } = await import('../server/catalog.js');
const { TIERS } = await import('../server/scoring.js');
const { default: qaRouter } = await import('../server/routes/qa.js');
const { createIntegrationService } = await import('../server/integrations.js');
const { createIntegrationsRouter } = await import('../server/routes/integrations.js');
const { createSmsService } = await import('../server/sms.js');
const { createSmsRouter } = await import('../server/routes/sms.js');
const { createSmsBatchService } = await import('../server/smsBatches.js');
const { createAssistantService } = await import('../server/assistant.js');
const { createAssistantRouter } = await import('../server/routes/assistant.js');
const { createCategoryCatalog } = await import('../server/categoryCatalog.js');
const { createCategoriesRouter, mountCategoryOAuthCallback } = await import('../server/routes/categories.js');
const categoryCatalog = createCategoryCatalog({ simulated: true });
const integrationFetch = createIntegrationsQaProvider();
const integrations = createIntegrationService({ fetchFn: integrationFetch, simulated: true });
const sms = createSmsService({ integrations, fetchFn: integrationFetch, simulated: true });
const smsBatches = createSmsBatchService({ sms, integrations, simulated: true, recoverInterrupted: true });
const assistant = createAssistantService({ integrations, fetchFn: integrationFetch, simulated: true });
const now = Date.now();
if (!existingFixture) {
const insert = db.prepare(`INSERT INTO businesses
  (place_id,name,category,website,country_code,phone_e164,whatsapp,emails,rating,review_count,score,tier,site_status,first_seen,last_seen)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
insert.run('qa-northstar', 'Northstar Security / QA simulator', 'Security company', 'https://example.com', 'CA', '+14165550123', '+14165550123', '["owner@example.com"]', 4.8, 120, 78, 'hot', 'none', now, now);
insert.run('qa-maple', 'Maple Dental / QA simulator', 'Dentist', 'https://example.org', 'CA', '+14165550124', '+14165550124', '["unknown@example.com"]', 4.6, 70, 68, 'hot', 'none', now, now);
insert.run('qa-willow', 'Willow Bookkeeping / QA simulator', 'Accountant', 'https://example.net', 'CA', null, null, '[]', 4.5, 35, 58, 'warm', 'none', now, now);
for (const slug of ['northstar', 'maple']) savePreview(`qa-${slug}`, {
  publicUrl: `https://designs.localgeni.app/qa/${slug}`, improvements: ['Clear services and contact details.'],
}); // Fictional link strings for template review only. They are never fetched.
const finishedPageQa = Buffer.from('<!doctype html>\r\n<html lang="en"><head><meta charset="utf-8"><title>Fictional finished page</title></head><body><h1>Northstar QA</h1><p>Exported by a separate design system. QA fixture only.</p><script>window.neverRunInLocalGeni=true;</script></body></html>\r\n', 'utf8');
previewFileService.save('qa-northstar', { filename: 'finished-page-qa.html', contentBase64: finishedPageQa.toString('base64') });
}
const whatsappProvider = createWhatsAppQaProvider({ startTime: now });
const whatsapp = createWhatsAppService({ fetchFn: whatsappProvider.fetchFn, now: whatsappProvider.now, keyProvider: () => Buffer.alloc(32, 23), autoStart: false });

const submitted = [];
const incoming = []; // Only fictional mail explicitly queued through the QA endpoint.
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const service = createEmailService({
  unsubscribeLink: ({ accountId, to }) => `https://qa.example.com/u/${Buffer.from(`${accountId}:${to}`).toString('base64url')}`,
  syncPublicOptOuts: async () => {},
  transportFactory: () => ({
    verify: async () => true,
    sendMail: async (message) => {
      submitted.push({ to: message.envelope.to[0], subject: message.subject, text: message.text, from: message.from, simulated: true });
      if (message.envelope.to[0].toLowerCase().startsWith('unknown@')) throw Object.assign(new Error('Simulated ambiguous connection loss'), { code: 'ECONNECTION', command: 'DATA' });
      if (message.envelope.to[0].toLowerCase().startsWith('failed@')) return { accepted: [], rejected: message.envelope.to };
      return { accepted: message.envelope.to, messageId: message.messageId };
    }, close() {},
  }),
  getDkimConfig: async (fromEmail) => {
    const dkim = infra.getInfrastructureSettings().dkim;
    if (!dkim?.enabled) return null;
    if (fromEmail.split('@')[1] !== dkim.domain) throw Object.assign(new Error('QA signing domain mismatch.'), { status: 409, code: 'DKIM_DOMAIN_MISMATCH' });
    return null; // Simulator never signs or transmits a message.
  },
  fetchFn: async (url, options) => {
    if (url.endsWith('/devicecode')) return jsonResponse({ device_code: 'QA_DEVICE_CODE', user_code: 'QA-123456', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 });
    if (url.endsWith('/token')) return jsonResponse({ access_token: 'QA_ACCESS_TOKEN', refresh_token: 'QA_REFRESH_TOKEN', token_type: 'Bearer', scope: 'User.Read Mail.Send Mail.Read', expires_in: 3600 });
    if (url.includes('/me?')) return jsonResponse({ mail: 'qa-microsoft@example.com', displayName: 'QA Microsoft Sender' });
    if (url.endsWith('/sendMail')) {
      if (options.headers['Content-Type'] === 'text/plain') {
        const message = await simpleParser(Buffer.from(options.body, 'base64'));
        submitted.push({ to: message.to.value[0].address, subject: message.subject, text: message.text, simulated: true });
      } else {
        const message = JSON.parse(options.body).message;
        submitted.push({ to: message.toRecipients[0].emailAddress.address, subject: message.subject, text: message.body.content, simulated: true });
      }
      return new Response(null, { status: 202 });
    }
    if (url.includes('/mailFolders/inbox/messages/delta')) return jsonResponse({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=qa' });
    if (url.includes('/mailFolders/inbox')) return jsonResponse({ id: 'QA_INBOX' });
    throw new Error('Unexpected provider URL in QA simulator');
  },
});
const inbox = createInboxService({ service, parser: simpleParser, imapFactory: async () => ({
  on() {}, connect: async () => {}, logout: async () => {}, mailbox: { uidValidity: 1 },
  getMailboxLock: async () => ({ release() {} }), search: async () => incoming.map((_, i) => i + 1),
  fetchOne: async (uid) => ({ source: Buffer.from(incoming[Number(uid) - 1]), internalDate: new Date() }),
}) });
const campaigns = createCampaignService({ service, inbox, syncPublicOptOuts: async () => {} });
const fakeDns = {
  resolveMx: async () => [{ priority: 10, exchange: 'mail.qa.example.com' }],
  resolve4: async () => ['192.0.2.1'], resolve6: async () => ['2001:db8::1'],
  resolveTxt: async (domain) => {
    if (domain.startsWith('_dmarc.')) return [['v=DMARC1; p=none;']];
    if (domain.includes('._domainkey.')) {
      const dkim = infra.getInfrastructureSettings().dkim;
      return dkim && domain === `${dkim.selector}._domainkey.${dkim.domain}` ? [[dkim.publicRecord]] : [];
    }
    return [['v=spf1 include:_spf.google.com ~all']];
  },
};
const app = express(); app.disable('x-powered-by');
app.use('/api', requireLocalEmailOrigin);
app.use(express.json({ limit: '8mb' }));
app.use('/api/crm', requireAuth, crmRouter);
app.use('/api/lists', requireAuth, listsRouter);
app.use('/api/custom-fields', requireAuth, customFieldsRouter);
app.use('/api/integrations', requireAuth, createIntegrationsRouter(integrations));
mountCategoryOAuthCallback(app);
app.use('/api/categories', requireAuth, createCategoriesRouter(categoryCatalog));
app.use('/api/sms', requireAuth, createSmsRouter(sms, smsBatches));
app.use('/api/assistant', requireAuth, createAssistantRouter(assistant));
app.get('/api/publishing/status',requireAuth,(req,res)=>res.json({configured:true,origin:'https://qa.example.com',verifiedAt:Date.now(),simulated:true}));
app.post('/api/publishing/verify',requireAuth,(req,res)=>res.json({configured:true,origin:'https://qa.example.com',verifiedAt:Date.now(),simulated:true}));
app.use('/api/qa',requireAuth,qaRouter);
app.use('/api/email', requireAuth, createEmailRouter(service, { inbox, campaigns }));
app.use('/api/whatsapp', requireAuth);
app.get('/api/whatsapp/qa/status', (req, res) => res.json({ simulated: true, messagesDelivered: 0, now: whatsappProvider.now(), account: WHATSAPP_QA_ACCOUNT, numbers: WHATSAPP_QA_NUMBERS, templateId: WHATSAPP_QA_TEMPLATE.id, automaticWorker: false }));
app.get('/api/whatsapp/qa/outbox', (req, res) => res.json({ simulated: true, messagesDelivered: 0, rows: whatsappProvider.outbox() }));
app.post('/api/whatsapp/qa/outcome', (req, res) => { whatsappProvider.setOutcome(req.body?.number, req.body?.outcome); res.json({ simulated: true, ok: true }); });
app.post('/api/whatsapp/qa/tick', async (req, res) => {
  whatsappProvider.advance(req.body?.advanceMs ?? 0);
  await whatsapp.tick();
  res.json({ simulated: true, messagesDelivered: 0, now: whatsappProvider.now(), batches: whatsapp.listBatches().rows, submissionCount: whatsappProvider.outbox().length });
});
app.use('/api/whatsapp', createWhatsAppRouter(whatsapp));
// Override every infrastructure operation that could otherwise perform DNS or provider I/O.
app.post('/api/email/domain/check', async (req, res) => res.json({ ...await infra.checkDomain(req.body, { dns: fakeDns }), simulated: true }));
app.post('/api/email/dkim/enabled', async (req, res) => res.json(await infra.setDkimEnabled(req.body?.enabled, { dns: fakeDns })));
app.post('/api/email/verification', async (req, res) => res.json({ ...await infra.verifyRecipient(req.body, {
  dns: fakeDns,
  fetchImpl: async (url) => jsonResponse({ address: new URL(url).searchParams.get('email'), status: 'valid', sub_status: '' }),
}), simulated: true }));
app.post('/api/email/qa/tick', async (req, res) => res.json({ ...await campaigns.tick(), simulated: true }));
app.post('/api/email/qa/inbound', (req, res) => {
  const accountId = req.body?.accountId || 'default';
  const original = db.prepare("SELECT * FROM email_messages WHERE account_id=? AND status='sent' ORDER BY accepted_at DESC LIMIT 1").get(accountId);
  if (!original) return res.status(409).json({ error: 'Submit a fictional email in the simulator before adding its reply.' });
  const kind = ['reply', 'opt_out', 'bounce'].includes(req.body?.kind) ? req.body.kind : 'reply';
  const message = { remoteId: `qa:${Date.now()}:${incoming.length}`, fromEmail: kind === 'bounce' ? 'mailer-daemon@example.com' : original.to_email,
    messageId: `<qa-reply-${Date.now()}@example.com>`, inReplyTo: original.provider_message_id, to: [original.from_email],
    subject: kind === 'bounce' ? 'Delivery status notification' : `Re: ${original.subject}`, receivedAt: Date.now(),
    text: kind === 'reply' ? 'Thanks, I would like to discuss the homepage.' : kind === 'opt_out' ? 'Please remove me from your list.' : `Final-Recipient: rfc822; ${original.to_email}\nAction: failed\nStatus: 5.1.1`,
    headers: kind === 'bounce' ? { 'content-type': 'multipart/report; report-type=delivery-status' } : {},
  };
  res.json({ simulated: true, message: inbox.ingest(accountId, message) });
});
app.get('/api/email/qa/outbox', (req, res) => res.json({ simulated: true, rows: submitted }));
app.post('/api/email/qa/clear-reservations', (req, res) => { db.prepare('DELETE FROM email_send_reservations').run(); res.json({ simulated: true, ok: true }); });
app.use('/api/email', infrastructureRouter);
app.use('/api/previews', requireAuth, previews);
app.use('/api/preview-files', requireAuth, previewFiles);
app.get('/api/meta', (req, res) => res.json({ countries, categories, tiers: TIERS, whatsappFirst: [...WHATSAPP_FIRST], placesKeyConfigured: false, costPer1000: 35, qaSimulator: true }));
// Preview geometry with an explicitly fictional area. No geocoder or search provider is called.
app.post('/api/area/resolve', requireAuth, (req, res) => {
  const center = { lat: 31.5085, lng: 74.31 }, radiusKm = Number(req.body.radiusKm || 1);
  const radius = req.body.coverageMode === 'radius';
  const bounds = radius ? radiusBounds(center, radiusKm) : { south: 31.5, west: 74.3, north: 31.535, east: 74.34 };
  const { cells, ...plan } = buildSearchPlan(bounds, Number(req.body.cellKm || 1));
  res.json({ name: 'Sample search area', address: 'Fictional preview boundary · no live location lookup', center, bounds, plan, simulated: true, ...(radius ? { radiusKm } : {}) });
});
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && (/^\/scans/.test(req.path) || req.path === '/area/resolve' || /\/reanalyze$/.test(req.path))) return res.status(403).json({ error: 'Scanning and external analysis are disabled in the QA simulator.' });
  next();
}, requireAuth, api);
const qaDist = path.join(ROOT, 'client', 'qa-dist');
const dist = fs.existsSync(path.join(qaDist, 'index.html')) ? qaDist : path.join(ROOT, 'client', 'dist');
app.use(express.static(dist, { index: false }));
app.get(/^\/(?!api\/).*/, (req, res) => {
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8').replace('<body>', '<body><div class="qa-simulator-badge" role="status">SAMPLE CRM / API SENDS SIMULATED</div>');
  res.type('html').send(html);
});
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.status ? err.message : 'QA simulator error', code: err.code || 'QA_ERROR' }));
const server = app.listen(qaPort, '127.0.0.1', () => {
  console.log(`Local Geni MESSAGING QA SIMULATOR: http://127.0.0.1:${qaPort}/#email`);
  console.log(`Isolated fixture: ${fixtureDir}`);
  console.log('Use fictional credentials. SMTP/Microsoft/DNS/Meta are simulated. NO MESSAGES DELIVERED.');
  console.log('WhatsApp fake setup: GET /api/whatsapp/qa/status. The WhatsApp worker runs only on an explicit QA tick.');
});
campaigns.startWorker();
smsBatches.startWorker();
const stop = () => { campaigns.stopWorker(); whatsapp.stopWorker(); smsBatches.stopWorker(); server.close(() => { db.close(); process.exit(0); }); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
