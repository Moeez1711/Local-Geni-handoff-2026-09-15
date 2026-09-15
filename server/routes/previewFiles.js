import { Router } from 'express';
import { archiveHtmlFiles, previewFileService } from '../previewFiles.js';

export function createPreviewFilesRouter(service = previewFileService) {
  const router = Router();
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Referrer-Policy': 'no-referrer' }); next();
  });
  router.post('/export-zip', (req, res, next) => {
    const { files, skipped } = service.zipFiles(req.body);
    const archive = archiveHtmlFiles(files);
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="finished-homepages.zip"', 'X-Exported-Files': String(files.length), 'X-Skipped-Businesses': String(skipped) });
    let failed = false;
    const fail = err => { if (failed || res.destroyed) return; failed = true; if (res.headersSent) res.destroy(err); else next(err); };
    archive.on('error', fail);
    res.on('close', () => { if (!res.writableFinished) archive.abort(); });
    archive.pipe(res); archive.finalize().catch(fail);
  });
  router.get('/:placeId', (req, res) => res.json(service.detail(req.params.placeId)));
  router.post('/:placeId', (req, res) => res.status(201).json(service.save(req.params.placeId, req.body)));
  router.get('/:placeId/download', (req, res) => {
    const file = service.download(req.params.placeId, req.query.versionId);
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${file.filename}"`, 'Content-Length': String(file.size), 'X-Content-SHA256': file.sha256 });
    res.send(file.bytes);
  });
  return router;
}
export default createPreviewFilesRouter();
