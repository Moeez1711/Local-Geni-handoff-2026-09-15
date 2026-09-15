import FirecrawlApp from '@mendable/firecrawl-js';
import { config } from './config.js';
import { integrationService } from './integrations.js';

/**
 * Resolve the active Firecrawl API key from integration vault or environment.
 */
export function getActiveFirecrawlKey(explicitKey = '') {
  if (explicitKey && typeof explicitKey === 'string' && explicitKey.trim()) {
    return explicitKey.trim();
  }
  try {
    const creds = integrationService.credentials('firecrawl');
    if (creds?.apiKey) return creds.apiKey;
  } catch {
    // integration not configured in vault
  }
  if (config.firecrawlKey) {
    return config.firecrawlKey;
  }
  return '';
}

/**
 * Initialize FirecrawlApp client instance.
 */
export function createFirecrawlClient(apiKeyOverride = '') {
  const key = getActiveFirecrawlKey(apiKeyOverride);
  if (!key) {
    throw new Error('Firecrawl API key is not configured. Connect it in Integrations or set FIRECRAWL_API_KEY in .env.');
  }
  return new FirecrawlApp({ apiKey: key });
}

/**
 * Scrape a single URL using Firecrawl.
 */
export async function scrapeUrl(url, options = {}) {
  const client = createFirecrawlClient(options.apiKey);
  const { apiKey, ...scrapeOptions } = options;
  return await client.scrapeUrl(url, {
    formats: ['markdown', 'html'],
    ...scrapeOptions,
  });
}

/**
 * Crawl a website using Firecrawl.
 */
export async function crawlUrl(url, options = {}) {
  const client = createFirecrawlClient(options.apiKey);
  const { apiKey, ...crawlOptions } = options;
  return await client.crawlUrl(url, crawlOptions);
}

/**
 * Map website URLs using Firecrawl.
 */
export async function mapUrl(url, options = {}) {
  const client = createFirecrawlClient(options.apiKey);
  const { apiKey, ...mapOptions } = options;
  return await client.mapUrl(url, mapOptions);
}

/**
 * Extract structured data from URLs using Firecrawl.
 */
export async function extractFromUrls(urls, schema, options = {}) {
  const client = createFirecrawlClient(options.apiKey);
  const { apiKey, ...extractOptions } = options;
  return await client.extract(urls, {
    schema,
    ...extractOptions,
  });
}

/**
 * Check if Firecrawl is configured and available.
 */
export function isFirecrawlConfigured() {
  return Boolean(getActiveFirecrawlKey());
}
