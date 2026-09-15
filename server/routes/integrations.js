import { Router } from 'express';
import { integrationService } from '../integrations.js';
export function createIntegrationsRouter(service = integrationService) {
  const router = Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/', (req, res) => res.json(service.list()));
  router.get('/:id', (req, res) => res.json(service.status(req.params.id)));
  router.put('/:id', (req, res) => res.json(service.save(req.params.id, req.body)));
  router.post('/:id/verify', async (req, res) => res.json(await service.verify(req.params.id)));
  router.delete('/:id', (req, res) => res.json(service.disconnect(req.params.id)));
  router.use((err, req, res, next) => res.status(err.integrationSafe ? err.status : 500).json({ error: err.integrationSafe ? err.message : 'The connection could not be updated.', code: err.integrationSafe ? err.code : 'INTEGRATION_FAILED' }));
  return router;
}
export default createIntegrationsRouter();
