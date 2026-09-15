import { Router } from 'express';
import { smsService } from '../sms.js';
import { smsBatchService } from '../smsBatches.js';
export function createSmsRouter(service = smsService, batches = smsBatchService) {
  const router = Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/connections', (req, res) => res.json(service.connections()));
  router.get('/messages', (req, res) => res.json(service.list()));
  router.get('/batches', (req, res) => res.json(batches.list()));
  router.get('/batches/:id', (req, res) => res.json(batches.detail(req.params.id)));
  router.post('/batches/preview', (req, res) => res.json(batches.preview(req.body)));
  router.post('/batches', (req, res) => res.json(batches.create(req.body)));
  router.post('/batches/:id/:action', (req, res) => res.json(batches.control(req.params.id,req.params.action)));
  router.post('/messages', async (req, res) => res.json(await service.send(req.body)));
  router.post('/messages/:id/refresh', async (req, res) => res.json(await service.refresh(req.params.id)));
  router.post('/blocked', (req, res) => res.json(service.suppress(req.body?.number)));
  router.use((err, req, res, next) => res.status(err.smsSafe || err.integrationSafe ? err.status : 500).json({ error: err.smsSafe || err.integrationSafe ? err.message : 'SMS could not be completed.', code: err.smsSafe || err.integrationSafe ? err.code : 'SMS_FAILED' }));
  return router;
}
export default createSmsRouter();
