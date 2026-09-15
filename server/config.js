import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { if (process.env.LOCAL_GENI_QA_ISOLATED !== '1') process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* env may come from the shell */ }

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : d);

const defaultAllowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isAllowedHost(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  if (defaultAllowedHosts.has(h)) return true;
  if (process.env.ALLOW_ALL_HOSTS === '1' || process.env.ALLOWED_HOSTS === '*') return true;
  const configured = (process.env.ALLOWED_HOSTS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  if (process.env.RENDER_EXTERNAL_HOSTNAME) configured.push(process.env.RENDER_EXTERNAL_HOSTNAME.trim().toLowerCase());
  if (configured.includes(h)) return true;
  if ((process.env.RENDER || process.env.NODE_ENV === 'production') && (h.endsWith('.onrender.com') || h.endsWith('.render.com'))) return true;
  return false;
}

export function isAllowedPort(port) {
  if (!port || port === '80' || port === '443') return true;
  return [String(config.port), '5173'].includes(port);
}

export const config = {
  port: num(process.env.PORT, 4000),
  host: process.env.HOST || (process.env.RENDER || process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
  placesKey: process.env.GOOGLE_PLACES_API_KEY || '',
  placesRps: num(process.env.PLACES_RPS, 5),
  placesCostPer1000: num(process.env.PLACES_COST_PER_1000, 35),
  cacheTtlMs: num(process.env.PLACES_CACHE_TTL_HOURS, 72) * 3600_000,
  websiteConcurrency: num(process.env.WEBSITE_CONCURRENCY, 4),
  firecrawlKey: process.env.FIRECRAWL_API_KEY || '',
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'leads.db'),
};

