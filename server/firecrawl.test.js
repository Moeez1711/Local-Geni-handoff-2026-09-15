import test from 'node:test';
import assert from 'node:assert/strict';
import { isFirecrawlConfigured, getActiveFirecrawlKey, createFirecrawlClient } from './firecrawlService.js';
import { createFirecrawlRouter } from './routes/firecrawl.js';

test('firecrawl key resolution falls back cleanly when unconfigured', () => {
  assert.equal(typeof isFirecrawlConfigured(), 'boolean');
  assert.equal(typeof getActiveFirecrawlKey(), 'string');
});

test('firecrawl client throws when initialized without key', () => {
  if (!isFirecrawlConfigured()) {
    assert.throws(() => createFirecrawlClient(), /Firecrawl API key is not configured/);
  }
});

test('firecrawl client initializes when key is provided', () => {
  const client = createFirecrawlClient('fc-test-key-12345');
  assert.ok(client);
  assert.equal(typeof client.scrapeUrl, 'function');
  assert.equal(typeof client.crawlUrl, 'function');
});

test('firecrawl router provides status and input validation', async () => {
  const router = createFirecrawlRouter();
  assert.ok(router);

  // Validate status endpoint
  const statusReq = { method: 'GET' };
  let statusResult;
  const statusRes = {
    set: () => {},
    json: (data) => { statusResult = data; }
  };
  const statusLayer = router.stack.find(l => l.route?.path === '/status');
  statusLayer.route.stack[0].handle(statusReq, statusRes);
  assert.equal(typeof statusResult.configured, 'boolean');

  // Validate scrape rejection on missing URL
  let scrapeErrStatus, scrapeErrBody;
  const scrapeRes = {
    status: (code) => {
      scrapeErrStatus = code;
      return { json: (body) => { scrapeErrBody = body; } };
    }
  };
  const scrapeLayer = router.stack.find(l => l.route?.path === '/scrape');
  await scrapeLayer.route.stack[0].handle({ body: {} }, scrapeRes);
  assert.equal(scrapeErrStatus, 400);
  assert.match(scrapeErrBody.error, /Valid URL is required/);
});
