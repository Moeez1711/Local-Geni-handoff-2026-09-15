/**
 * Google Places API (New) lead source.
 * Implements the LeadSource contract (see providers/index.js):
 *   resolveArea(input, ctx)  -> { name, address, center, bounds }
 *   searchArea(input, ctx)   -> { places: NormalizedPlace[], pages, saturated }
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db.js';
import { emit } from '../events.js';
import { createRateLimiter, sleep } from '../util.js';
import { assertSearchAllowed, getLimits } from '../limits.js';
import { radiusBounds } from '../../shared/searchPlan.js';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const PAGE_SIZE = 20;
const MAX_PAGES = 3; // Text Search (New) returns at most 60 results per query

const SEARCH_FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
  'places.types', 'places.primaryType', 'places.primaryTypeDisplayName', 'places.googleMapsUri',
  'places.businessStatus', 'places.nationalPhoneNumber', 'places.internationalPhoneNumber',
  'places.websiteUri', 'places.rating', 'places.userRatingCount',
  'places.regularOpeningHours', 'places.currentOpeningHours', 'nextPageToken',
].join(',');
const AREA_FIELDS = 'places.id,places.displayName,places.formattedAddress,places.location,places.viewport,places.types';

const acquire = createRateLimiter(config.placesRps);

export class ProviderError extends Error {
  constructor(message, { status, code, fatal = false, retryable = false } = {}) {
    super(message);
    Object.assign(this, { status, code, fatal, retryable });
  }
}

const logCall = db.prepare(`INSERT INTO api_calls (ts, scan_id, provider, endpoint, outcome, http_code, ms, error) VALUES (?,?,?,?,?,?,?,?)`);
const getCache = db.prepare(`SELECT response, created_at FROM api_cache WHERE key = ?`);
const putCache = db.prepare(`INSERT OR REPLACE INTO api_cache (key, response, created_at) VALUES (?,?,?)`);

function record(scanId, endpoint, outcome, httpCode, ms, error) {
  logCall.run(Date.now(), scanId ?? null, 'google_places', endpoint, outcome, httpCode ?? null, ms ?? null, error ?? null);
  emit('api', { scanId, endpoint, outcome, httpCode, ms, error });
}

async function post(body, fieldMask, { scanId, signal, endpoint }) {
  if (!config.placesKey) throw new ProviderError('GOOGLE_PLACES_API_KEY is not set on the server', { fatal: true });
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (signal?.aborted) throw new ProviderError('aborted', { code: 'ABORTED' });
    await acquire();
    const started = Date.now();
    let res, text;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': config.placesKey, 'X-Goog-FieldMask': fieldMask },
        body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
      });
      text = await res.text();
    } catch (e) {
      if (signal?.aborted) throw new ProviderError('aborted', { code: 'ABORTED' });
      lastErr = new ProviderError(`Network error: ${e.message}`, { retryable: true });
      record(scanId, endpoint, 'error', null, Date.now() - started, lastErr.message);
      await sleep(1000 * 2 ** attempt, signal);
      continue;
    }
    const ms = Date.now() - started;
    if (res.ok) { record(scanId, endpoint, 'ok', res.status, ms); return JSON.parse(text || '{}'); }

    let payload; try { payload = JSON.parse(text); } catch { payload = {}; }
    const msg = payload?.error?.message || `HTTP ${res.status}`;
    const code = payload?.error?.status;
    record(scanId, endpoint, 'error', res.status, ms, `${code || ''} ${msg}`.trim());

    if (res.status === 429 || res.status >= 500) {
      lastErr = new ProviderError(msg, { status: res.status, code, retryable: true });
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      await sleep((retryAfter || 1500 * 2 ** attempt) + Math.random() * 400, signal);
      continue;
    }
    // 400 on a fresh page token can happen if it's used too quickly; retry once.
    if (res.status === 400 && body.pageToken && attempt === 0) { await sleep(1500, signal); continue; }
    throw new ProviderError(msg, { status: res.status, code, fatal: res.status === 401 || res.status === 403 });
  }
  throw lastErr;
}

let searchesInFlight = 0;
const scanRequestsInFlight = new Map();

/** Cached wrapper: identical query+fields within the reuse window cost nothing. Billable searches are limit-checked first. */
async function cachedPost(body, fieldMask, ctx) {
  const key = crypto.createHash('sha1').update(fieldMask + JSON.stringify(body)).digest('hex');
  const hit = getCache.get(key);
  if (hit && Date.now() - hit.created_at < getLimits().cacheHours * 3600_000) {
    record(ctx.scanId, ctx.endpoint, 'cached', null, 0);
    return JSON.parse(hit.response);
  }
  const billable = ctx.endpoint === 'searchText';
  if (billable) {
    assertSearchAllowed(searchesInFlight);
    if (ctx.scanId && ctx.maxApiCalls) {
      const used = db.prepare(`SELECT COUNT(*) n FROM api_calls WHERE scan_id=? AND outcome='ok' AND endpoint='searchText'
        AND ts >= (SELECT created_at FROM scans WHERE id=?)`).get(ctx.scanId, ctx.scanId).n;
      if (used + (scanRequestsInFlight.get(ctx.scanId) || 0) >= ctx.maxApiCalls) throw new ProviderError('Search request budget reached. Raise the budget and resume to continue the remaining areas.', { code: 'LIMIT' });
    }
    searchesInFlight++;
    if (ctx.scanId) scanRequestsInFlight.set(ctx.scanId, (scanRequestsInFlight.get(ctx.scanId) || 0) + 1);
  }
  try {
    const data = await post(body, fieldMask, ctx);
    putCache.run(key, JSON.stringify(data), Date.now());
    return data;
  } finally {
    if (billable) {
      searchesInFlight--;
      if (ctx.scanId) {
        const remaining = (scanRequestsInFlight.get(ctx.scanId) || 1) - 1;
        if (remaining) scanRequestsInFlight.set(ctx.scanId, remaining); else scanRequestsInFlight.delete(ctx.scanId);
      }
    }
  }
}

const toBounds = (vp) => vp && ({ south: vp.low.latitude, west: vp.low.longitude, north: vp.high.latitude, east: vp.high.longitude });
const kmToLat = (km) => km / 110.574;

export async function resolveArea({ area, countryName, regionCode, radiusKm = 1, coverageMode = 'area' }, ctx = {}) {
  const textQuery = [area, countryName].filter(Boolean).join(', ');
  const data = await cachedPost({ textQuery, regionCode, pageSize: 1 }, AREA_FIELDS, { ...ctx, endpoint: 'resolveArea' });
  const p = data.places?.[0];
  if (!p) throw new ProviderError(`Could not locate "${textQuery}" on Google Maps`, { fatal: true });
  const center = { lat: p.location.latitude, lng: p.location.longitude };
  let bounds = toBounds(p.viewport);
  const tiny = !bounds || (bounds.north - bounds.south) < kmToLat(0.8);
  if (tiny || coverageMode === 'radius') bounds = radiusBounds(center, radiusKm);
  return { name: p.displayName?.text || area, address: p.formattedAddress, center, bounds, expanded: tiny,
    ...(coverageMode === 'radius' ? { radiusKm } : {}) };
}

function normalize(p) {
  return {
    sourceId: p.id,
    name: p.displayName?.text || '(unnamed)',
    address: p.formattedAddress || null,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    phoneNational: p.nationalPhoneNumber || null,
    phoneIntl: p.internationalPhoneNumber || null,
    website: p.websiteUri || null,
    rating: p.rating ?? null,
    reviewCount: p.userRatingCount ?? null,
    category: p.primaryTypeDisplayName?.text || p.primaryType || null,
    types: p.types || [],
    businessStatus: p.businessStatus || null,
    openNow: p.currentOpeningHours?.openNow ?? null,
    hours: p.regularOpeningHours?.weekdayDescriptions || null,
    mapsUrl: p.googleMapsUri || null,
  };
}

/** Fetches every page (max 3) for one query inside one rectangle. */
export async function searchArea({ textQuery, bounds, regionCode, languageCode = 'en' }, ctx = {}) {
  const base = {
    textQuery, regionCode, languageCode, pageSize: PAGE_SIZE,
    locationRestriction: { rectangle: { low: { latitude: bounds.south, longitude: bounds.west }, high: { latitude: bounds.north, longitude: bounds.east } } },
  };
  const places = [];
  let pageToken = ctx.pageToken || undefined, pages = ctx.pages || 0, resultCount = ctx.resultCount || 0;
  do {
    if (ctx.shouldPause?.()) throw new ProviderError('Search paused', { code: 'ABORTED' });
    const data = await cachedPost(pageToken ? { ...base, pageToken } : base, SEARCH_FIELDS, { ...ctx, endpoint: 'searchText' });
    pages++;
    const batch = (data.places || []).map(normalize);
    places.push(...batch); resultCount += batch.length;
    pageToken = data.nextPageToken;
    const complete = !pageToken || pages >= MAX_PAGES;
    await ctx.onPage?.({ places: batch, pages, resultCount, nextPageToken: pageToken || null, complete,
      saturated: complete && pages >= MAX_PAGES && resultCount > PAGE_SIZE * 2 });
  } while (pageToken && pages < MAX_PAGES);
  // Hitting the 3rd page means Google likely has more here than it will return: subdivide.
  return { places, pages, saturated: pages >= MAX_PAGES && resultCount > 2 * PAGE_SIZE };
}

export const googlePlacesSource = { id: 'google_places', resolveArea, searchArea, estimatedCostPer1000: config.placesCostPer1000 };
