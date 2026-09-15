import crypto from 'node:crypto';
import { Router } from 'express';
import { categoryCatalog, CATEGORY_CALLBACK } from '../categoryCatalog.js';
import { workspacePermissionBinding, requireWorkspacePermission } from '../auth.js';
import { config } from '../config.js';

export function createCategoriesRouter(service = categoryCatalog) {
  const router = Router();
  router.get('/', (req, res) => res.json(service.list(req.query.country || 'US', req.query.language || 'en', req.query.all === 'true')));
  router.get('/status', (req, res) => res.json(service.status()));
  router.use(requireWorkspacePermission('manageConnections'));
  const actor = req => {
    const binding = workspacePermissionBinding(req, 'manageConnections');
    return { binding, assertCurrent() { if (workspacePermissionBinding(req, 'manageConnections') !== binding) throw Object.assign(new Error('Workspace access changed. Try again.'), { status: 409 }); } };
  };
  router.put('/connection', (req, res) => res.json(service.configure(req.body || {})));
  router.post('/oauth/begin', (req, res) => {
    const origin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
    res.json(service.begin({ origin, ...actor(req) }));
  });
  router.post('/oauth/complete', async (req, res) => res.json(await service.complete({ state: req.body?.state, code: req.body?.code, ...actor(req) })));
  router.post('/refresh', async (req, res) => res.json(await service.refresh({ country: req.body?.country, language: req.body?.language, ...actor(req) })));
  router.put('/automatic', (req, res) => res.json(service.setAuto(req.body?.enabled)));
  router.delete('/connection', (req, res) => res.json(service.disconnect()));
  return router;
}

/** Google returns cross-site; exchange happens after returning to the authenticated app. */
export function mountCategoryOAuthCallback(app) {
  app.get(CATEGORY_CALLBACK, (req, res) => {
    let host;
    try { host = new URL(`http://${req.get('host')}`); } catch { return res.sendStatus(400); }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) || ![String(config.port), '5173'].includes(host.port)) return res.sendStatus(403);
    const nonce = crypto.randomBytes(18).toString('base64');
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'` });
    res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Connecting Google · Local Geni</title><body><p>Returning to Local Geni…</p><script nonce="${nonce}">
      const params = new URLSearchParams(location.search);
      const state = params.get('state');
      const expected = sessionStorage.getItem('local-geni-category-state');
      sessionStorage.removeItem('local-geni-category-state');
      sessionStorage.setItem('local-geni-category-result', JSON.stringify(state && state === expected
        ? {state, code: params.get('code'), denied: Boolean(params.get('error'))}
        : {denied: true}));
      location.replace('/#categories');
    </script></body></html>`);
  });
}
export default createCategoriesRouter();
