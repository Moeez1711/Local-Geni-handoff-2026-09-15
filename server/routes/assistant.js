import { Router } from 'express';
import { assistantService } from '../assistant.js';
export function createAssistantRouter(service = assistantService) {
  const router = Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/connections', (req, res) => res.json(service.connections()));
  router.get('/models/:provider', async (req, res) => res.json(await service.models(req.params.provider)));
  router.post('/chat', async (req, res) => res.json(await service.chat(req.body)));
  router.use((err, req, res, next) => res.status(err.assistantSafe || err.integrationSafe ? err.status : 500).json({ error: err.assistantSafe || err.integrationSafe ? err.message : 'Ask Geni could not complete this request.' }));
  return router;
}
export default createAssistantRouter();
