import { Router } from 'express';
import { config } from '../config.js';
import { bus } from '../events.js';
import { categories, countries, WHATSAPP_FIRST } from '../catalog.js';
import { TIERS } from '../scoring.js';
import * as repo from '../repo.js';
import * as engine from '../scanner/engine.js';
import { kickSites, siteQueueState } from '../enrich/siteQueue.js';
import { toCsv, toXlsx, exportColumnMetadata, exportPreview, exportSelection } from '../export.js';
import { getCustomFieldsForExport } from '../customFields.js';
import { saveLimits, usage } from '../limits.js';
import { authRouter } from '../auth.js';

const api = Router();
api.use('/auth', authRouter);

api.get('/meta', (req, res) => res.json({
  countries, categories, tiers: TIERS, whatsappFirst: [...WHATSAPP_FIRST],
  placesKeyConfigured: Boolean(config.placesKey), costPer1000: config.placesCostPer1000,
}));

api.get('/settings', (req, res) => res.json(repo.getSettings()));
api.put('/settings', (req, res) => res.json(repo.saveSettings(req.body)));
api.get('/followups', (req, res) => res.json(repo.followUpSummary()));
api.get('/limits', (req, res) => res.json(usage()));
api.put('/limits', (req, res) => { saveLimits(req.body); res.json(usage()); });

// Server-Sent Events: one stream for all live updates.
api.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
  bus.on('event', send);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => { bus.off('event', send); clearInterval(ping); });
});

api.post('/area/resolve', async (req, res) => res.json(await engine.previewArea(req.body)));

api.get('/scans', (req, res) => res.json(engine.listScans()));
api.get('/scans/:id/coverage', (req, res) => res.json(engine.scanCoverage(req.params.id)));
api.post('/scans', async (req, res) => res.status(201).json(await engine.createScan(req.body)));
api.get('/scans/:id', (req, res) => {
  const scan = engine.getScan(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  res.json(scan);
});
api.post('/scans/:id/pause', (req, res) => res.json(engine.pauseScan(req.params.id)));
api.post('/scans/:id/resume', (req, res) => res.json(engine.resumeScan(req.params.id, req.body)));
api.post('/scans/:id/stop', (req, res) => res.json(engine.stopScan(req.params.id)));
api.delete('/scans/:id', (req, res) => { engine.deleteScan(req.params.id); res.status(204).end(); });

api.get('/leads', (req, res) => res.json(repo.queryLeads(req.query)));
api.get('/leads/map', (req, res) => res.json(repo.mapPoints(req.query)));
api.get('/leads/categories', (req, res) => res.json(repo.categoriesInUse(req.query)));
api.get('/leads/countries', (req, res) => res.json(repo.countriesInUse(req.query)));
api.get('/leads/search-categories', (req, res) => res.json(repo.searchCategoriesInUse(req.query)));
api.post('/leads/delete', (req, res) => { if (req.body?.confirmed !== true) return res.status(400).json({ error: 'Confirm the leads to delete.' }); res.json(repo.trashLeads(req.body.ids)); });
api.post('/leads/restore', (req, res) => { const result = repo.trashLeads(req.body?.ids, true); if (result.count) kickSites(); res.json(result); });
api.get('/leads/:placeId', (req, res) => {
  const lead = repo.getLead(req.params.placeId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json(lead);
});
api.patch('/leads/:placeId', (req, res) => res.json(repo.updateLead(req.params.placeId, req.body)));
api.post('/leads/:placeId/reanalyze', (req, res) => { const lead = repo.requeueSite(req.params.placeId); kickSites(); res.json(lead); });

api.get('/analytics', (req, res) => res.json({ ...repo.analytics(req.query.scanId), siteQueue: siteQueueState(), usage: usage() }));

api.get('/export/columns', (req, res) => res.json({ columns: exportColumnMetadata(getCustomFieldsForExport([])) }));
api.post('/export/preview', (req, res) => {
  const selection = exportSelection(req.body);
  const { rows, total } = selection.empty ? { rows: [], total: 0 } : repo.queryLeads({ ...selection.filters, limit: 5 });
  res.json({ total, exportCount: Math.min(total, 5000), ...exportPreview(rows, { ...getCustomFieldsForExport(rows), columns: req.body?.columns }) });
});
// Preview and download share the same row selection and column getters.
api.post('/export', async (req, res) => {
  const { format = 'csv', columns } = req.body || {};
  if (!['csv', 'xlsx'].includes(format)) return res.status(400).json({ error: 'Choose Excel or CSV.' });
  const selection = exportSelection(req.body);
  const { rows } = selection.empty ? { rows: [] } : repo.queryLeads({ ...selection.filters, limit: 5000 });
  const options = { ...getCustomFieldsForExport(rows), columns };
  exportPreview([], options); // validate selected columns before setting download headers
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  if (format === 'xlsx') {
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="leads-${stamp}.xlsx"` });
    return res.send(Buffer.from(await toXlsx(rows, options)));
  }
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="leads-${stamp}.csv"` });
  res.send(toCsv(rows, options));
});

export default api;
