import { Router } from 'express';
import { listService } from '../lists.js';

export function createListsRouter(service = listService) {
  const router = Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/', (req, res) => res.json(service.list(req.query.archived === 'true')));
  router.post('/', (req, res) => res.status(201).json(service.save(req.body)));
  router.post('/preview', (req, res) => res.json(service.preview(req.body?.filters)));
  router.get('/:id', (req, res) => res.json(service.members(req.params.id, req.query)));
  router.put('/:id', (req, res) => res.json(service.save(req.body, req.params.id)));
  router.post('/:id/recipients', (req, res) => res.json(service.recipients(req.params.id, req.body)));
  router.post('/:id/archive', (req, res) => res.json(service.archive(req.params.id, req.body)));
  router.post('/:id/restore', (req, res) => res.json(service.archive(req.params.id, req.body, true)));
  return router;
}
export default createListsRouter();
