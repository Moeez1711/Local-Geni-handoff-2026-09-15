import { Router, raw } from 'express';

// Mount before JSON parsing, session authentication and the /api origin guard.
// Authentication is Meta's HMAC signature over the exact raw request bytes.
export function createWhatsAppWebhookRouter(service) {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/', (req, res) => res.type('text/plain').send(service.businessInbox.verifyWebhookChallenge(req.query)));
  router.post('/', raw({ type: 'application/json', limit: '1mb', inflate: false }), (req, res) => {
    service.businessInbox.ingestVerifiedWebhook(req.body, req.get('x-hub-signature-256'));
    res.json({ received: true });
  });
  router.use((error, _req, res, _next) => res.status(error.whatsappSafe ? error.status : error.status === 413 ? 413 : 400).json({ error: error.whatsappSafe ? error.message : 'Webhook request rejected.' }));
  return router;
}
