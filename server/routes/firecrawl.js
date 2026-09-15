import { Router } from 'express';
import { isFirecrawlConfigured, scrapeUrl, crawlUrl, mapUrl } from '../firecrawlService.js';

export function createFirecrawlRouter() {
  const router = Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.get('/status', (req, res) => {
    res.json({ configured: isFirecrawlConfigured() });
  });

  router.post('/scrape', async (req, res, next) => {
    const { url, ...options } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Valid URL is required to scrape.' });
    }
    try {
      const result = await scrapeUrl(url.trim(), options);
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Firecrawl scrape failed.' });
    }
  });

  router.post('/crawl', async (req, res, next) => {
    const { url, ...options } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Valid URL is required to crawl.' });
    }
    try {
      const result = await crawlUrl(url.trim(), options);
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Firecrawl crawl failed.' });
    }
  });

  router.post('/map', async (req, res, next) => {
    const { url, ...options } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Valid URL is required to map.' });
    }
    try {
      const result = await mapUrl(url.trim(), options);
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Firecrawl map failed.' });
    }
  });

  return router;
}

export default createFirecrawlRouter();
