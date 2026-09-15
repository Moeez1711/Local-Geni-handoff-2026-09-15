import { Router } from 'express';
import { config, isAllowedHost, isAllowedPort } from '../config.js';
import { emailService } from '../emailService.js';
import { accountIds, createAccount, currentAccountId, selectAccount, deleteAccount } from '../emailAccounts.js';
import { inboxService } from '../emailInbox.js';
import { campaignService } from '../emailCampaigns.js';

/** Blocks remote origins and DNS rebinding even when dashboard login is disabled. */
export function requireLocalEmailOrigin(req, res, next) {
  const deny = () => res.status(403).json({ error: 'Local Geni actions are available only from this local app.', code: 'EMAIL_ORIGIN_DENIED' });
  try {
    const host = new URL(`http://${req.get('host') || ''}`);
    if (!isAllowedHost(host.hostname) || !isAllowedPort(host.port) || host.username || host.password || host.pathname !== '/' || host.search || host.hash) return deny();
    const origin = req.get('origin');
    if (origin) {
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol) || !isAllowedHost(parsed.hostname) || !isAllowedPort(parsed.port) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return deny();
    } else {
      if (req.get('sec-fetch-site') === 'cross-site') return deny();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('sec-fetch-site') !== 'same-origin') return deny();
    }
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    next();
  } catch { return deny(); }
}

export function createEmailRouter(service = emailService, { inbox = inboxService, campaigns = campaignService } = {}) {
  const router = Router();
  const selected = (req) => service.forAccount(req.query.accountId || req.body?.accountId || currentAccountId());
  router.use(requireLocalEmailOrigin);
  router.get('/accounts', (req, res) => res.json({ rows: accountIds().map((id) => service.forAccount(id).getSettings()), currentAccountId: currentAccountId() }));
  router.post('/accounts', (req, res) => { const id = createAccount(req.body); const account = service.forAccount(id); if (req.body?.fromEmail || req.body?.clientId) account.saveSettings(req.body); res.json(account.getSettings()); });
  router.post('/accounts/:id/select', (req, res) => { selectAccount(req.params.id); res.json(service.forAccount(req.params.id).getSettings()); });
  router.delete('/accounts/:id', (req, res) => { service.forAccount(req.params.id).disconnect(); deleteAccount(req.params.id); res.json({ ok: true, currentAccountId: currentAccountId() }); });
  router.put('/accounts/:id/inbox', (req, res) => res.json(inbox.saveSettings(req.params.id, req.body)));
  router.post('/accounts/:id/inbox/verify', async (req, res) => res.json(await inbox.verify(req.params.id)));
  router.get('/inbox', (req, res) => res.json(inbox.list(req.query)));
  router.post('/inbox/sync', async (req, res) => res.json(await inbox.sync(req.body?.accountId || currentAccountId())));
  router.post('/inbox/:id/classify', (req, res) => res.json(inbox.classify(req.params.id, req.body?.kind)));
  router.get('/campaigns', (req, res) => res.json(campaigns.list()));
  router.post('/campaigns', (req, res) => res.json(campaigns.create(req.body)));
  router.get('/campaigns/:id', (req, res) => res.json(campaigns.detail(req.params.id)));
  router.put('/campaigns/:id', (req, res) => res.json(campaigns.update(req.params.id, req.body)));
  router.post('/campaigns/:id/review', (req, res) => res.json(campaigns.review(req.params.id)));
  router.post('/campaigns/:id/prepare', (req, res) => res.json(campaigns.review(req.params.id)));
  router.post('/campaigns/:id/start', (req, res) => res.json(campaigns.start(req.params.id, req.body)));
  for (const action of ['pause', 'resume', 'cancel']) router.post(`/campaigns/:id/${action}`, (req, res) => res.json(campaigns.action(req.params.id, action)));
  router.get('/settings', (req, res) => res.json(selected(req).getSettings()));
  router.put('/settings', (req, res) => res.json(selected(req).saveSettings(req.body)));
  router.post('/verify', async (req, res) => res.json(await selected(req).verify()));
  router.post('/microsoft/start', async (req, res) => res.json(await selected(req).startMicrosoft(req.body)));
  router.post('/microsoft/poll', async (req, res) => res.json(await selected(req).pollMicrosoft()));
  router.post('/microsoft/cancel', (req, res) => res.json(selected(req).cancelMicrosoft()));
  router.delete('/connection', (req, res) => res.json(selected(req).disconnect()));
  router.get('/messages', (req, res) => res.json(selected(req).listMessages(req.query)));
  router.post('/prepare', (req, res) => res.json(selected(req).prepare(req.body)));
  router.post('/send', async (req, res) => res.json(await selected(req).sendEmail(req.body)));
  router.use((err, req, res, next) => { // Safe boundary: never pass provider messages or credentials to app logging.
    const safe = err.emailSafe || (Number(err.status) >= 400 && Number(err.status) < 500 && typeof err.code === 'string');
    res.status(safe ? err.status : 500).json({ error: safe ? err.message : 'The email operation could not be completed. Review its history before trying another send.', code: safe ? err.code : 'EMAIL_OPERATION_FAILED' });
  });
  return router;
}

export default createEmailRouter();
