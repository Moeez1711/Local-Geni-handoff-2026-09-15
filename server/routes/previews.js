/** Private external design links, project progress, and outreach activity. */
import { Router } from 'express';
import * as previews from '../previewRepo.js';

const router = Router();
router.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); next(); });
router.get('/', (req, res) => res.json(previews.listPreviews(req.query)));
router.get('/:placeId', (req, res) => res.json(previews.getPreview(req.params.placeId)));
router.put('/:placeId', (req, res) => res.json(previews.savePreview(req.params.placeId, req.body)));
router.post('/:placeId/activity', (req, res) => res.json(previews.recordActivity(req.params.placeId, req.body)));

export default router;
