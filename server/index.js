import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config, ROOT } from './config.js';
import api from './routes/api.js';
import { requireAuth } from './auth.js';
import { shutdown } from './scanner/engine.js';
import { kickSites } from './enrich/siteQueue.js';
import previews from './routes/previews.js';
import previewFiles from './routes/previewFiles.js';
import emailRouter, { requireLocalEmailOrigin } from './routes/email.js';
import emailInfrastructure from './routes/emailInfrastructure.js';
import publishingRouter from './routes/publishing.js';
import qaRouter from './routes/qa.js';
import { setEmailUnsubscribeProvider, setEmailPublicSync } from './emailService.js';
import { campaignService, setEmailCampaignPublicSync } from './emailCampaigns.js';
import { getUnsubscribeLink, syncPublicOptOuts } from './publicPublishing.js';
import { startQaAgent } from './qaAgent.js';
import whatsappRouter from './routes/whatsapp.js';
import { whatsappService } from './whatsappService.js';
import { createWhatsAppWebhookRouter } from './routes/whatsappWebhook.js';
import crmRouter from './routes/crm.js';
import listsRouter from './routes/lists.js';
import customFieldsRouter from './routes/customFields.js';
import integrationsRouter from './routes/integrations.js';
import smsRouter from './routes/sms.js';
import assistantRouter from './routes/assistant.js';
import { smsBatchService } from './smsBatches.js';
import categoriesRouter, { mountCategoryOAuthCallback } from './routes/categories.js';
import { categoryCatalog } from './categoryCatalog.js';
import firecrawlRouter from './routes/firecrawl.js';

setEmailUnsubscribeProvider(getUnsubscribeLink);
setEmailPublicSync(syncPublicOptOuts);
setEmailCampaignPublicSync(syncPublicOptOuts);

const app = express();
app.disable('x-powered-by');
mountCategoryOAuthCallback(app);
app.use('/webhooks/whatsapp', createWhatsAppWebhookRouter(whatsappService));
app.use('/api', requireLocalEmailOrigin);
app.use('/api/preview-files', express.json({ limit: '5mb' }), requireAuth, previewFiles);
app.use('/api/previews', express.json({ limit: '8mb' }), requireAuth, previews);
app.use(express.json({ limit: '2mb' }));
app.use('/api/crm', requireAuth, crmRouter);
app.use('/api/lists', requireAuth, listsRouter);
app.use('/api/custom-fields', requireAuth, customFieldsRouter);
app.use('/api/integrations', requireAuth, integrationsRouter);
app.use('/api/firecrawl', requireAuth, firecrawlRouter);
app.use('/api/categories', requireAuth, categoriesRouter);
app.use('/api/sms', requireAuth, smsRouter);
app.use('/api/assistant', requireAuth, assistantRouter);
app.use('/api/email', requireAuth, emailRouter, emailInfrastructure);
app.use('/api/whatsapp', requireAuth, whatsappRouter);
app.use('/api/publishing', requireAuth, publishingRouter);
app.use('/api/qa', requireAuth, qaRouter);
app.use('/api', requireAuth, api);
app.use('/api', (req, res) => res.status(404).json({ error: 'This feature is not available.' }));
app.use('/p', (req, res) => res.status(404).send('Homepage designs are hosted by your external design system.'));

const dist = path.join(ROOT, 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Server error' });
});

// Bound to localhost: this is a personal tool and the server holds the Places API key.
let stopQa = () => {};
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`Local Geni on http://127.0.0.1:${config.port}`);
  if (!config.placesKey) console.warn('GOOGLE_PLACES_API_KEY missing; add it to .env');
  kickSites(); // finish website analyses left pending by a previous run
  campaignService.startWorker();
  whatsappService.startWorker();
  smsBatchService.startWorker();
  categoryCatalog.startWorker();
  stopQa = startQaAgent();
});

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  stopQa();
  campaignService.stopWorker();
  whatsappService.stopWorker();
  smsBatchService.stopWorker();
  categoryCatalog.stopWorker();
  await shutdown(); // running scans are marked "interrupted" and can be resumed
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
