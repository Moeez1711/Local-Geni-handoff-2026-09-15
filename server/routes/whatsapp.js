import { Router } from 'express';
import { whatsappService } from '../whatsappService.js';
import { requireLocalEmailOrigin } from './email.js';

export function createWhatsAppRouter(service = whatsappService) {
  const router = Router();
  router.use(requireLocalEmailOrigin);
  router.get('/inbox/settings', (req,res) => res.json(service.businessInbox.getStatus()));
  router.put('/inbox/settings', (req,res) => res.json(service.businessInbox.saveConfiguration(req.body)));
  router.get('/inbox/threads', (req,res) => res.json(service.businessInbox.listThreads()));
  router.get('/inbox/messages', (req,res) => res.json(service.businessInbox.listMessages(req.query)));
  router.post('/inbox/reply', async (req,res) => res.json(await service.businessInbox.sendReply(req.body)));
  router.get('/settings', (req,res) => res.json(service.getSettings()));
  router.put('/settings', (req,res) => res.json(service.saveSettings(req.body)));
  router.post('/verify', async (req,res) => res.json(await service.verifyConnection()));
  router.delete('/connection', (req,res) => res.json(service.disconnect()));
  router.get('/templates', (req,res) => res.json(service.listTemplates()));
  router.post('/templates/sync', async (req,res) => res.json(await service.syncTemplates()));
  router.get('/consents', (req,res) => res.json(service.listConsents(req.query)));
  router.get('/suppressions', (req,res) => res.json(service.listSuppressions(req.query)));
  router.put('/consents/:placeId', (req,res) => res.json(service.saveConsent(req.params.placeId,req.body)));
  router.post('/prepare', async (req,res) => res.json(await service.prepareBatch(req.body)));
  router.post('/send', (req,res) => res.status(202).json(service.sendBatch(req.body)));
  router.get('/batches', (req,res) => res.json(service.listBatches(req.query)));
  router.get('/batches/:id', (req,res) => res.json({ batch:service.getBatch(req.params.id) }));
  router.post('/batches/:id/cancel', (req,res) => res.json(service.cancelBatch(req.params.id)));
  router.post('/batches/:id/resume', (req,res) => res.json(service.resumeBatch(req.params.id,req.body)));
  router.get('/messages', (req,res) => res.json(service.listMessages(req.query)));
  router.use((error,req,res,next) => res.status(error.whatsappSafe ? error.status : 500).json({ error:error.whatsappSafe ? error.message : 'The WhatsApp operation could not be completed. Review batch history before another submission.', code:error.whatsappSafe ? error.code : 'WHATSAPP_OPERATION_FAILED' }));
  return router;
}
export default createWhatsAppRouter();
