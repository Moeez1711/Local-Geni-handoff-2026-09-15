import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchPlan, radiusBounds, insideSearchArea, distanceKm, normalizeLeadFilters, leadFilterReason } from '../shared/searchPlan.js';

process.env.LOCAL_GENI_QA_ISOLATED = '1';
process.env.DB_PATH = ':memory:';
process.env.WEBSITE_CONCURRENCY = '0';
process.env.GOOGLE_PLACES_API_KEY = 'fictional-test-key';
process.env.PLACES_RPS = '1000';
const { db } = await import('./db.js');
const engine = await import('./scanner/engine.js');
const { googlePlacesSource } = await import('./providers/googlePlaces.js');
const { saveLimits } = await import('./limits.js');
const { upsertPlace } = await import('./repo.js');
const originalFetch = globalThis.fetch;
const originalSearch = googlePlacesSource.searchArea;
const bounds = { south: 31.5, west: 74.3, north: 31.517, east: 74.32 };
const center = { lat: 31.5085, lng: 74.31 };
const base = { country: 'PK', area: 'Fictional test area', customCategory: 'barber', bounds, cellKm: 1, completionMode: 'coverage', targetCount: 1, maxApiCalls: 100 };
const response = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
const googlePlace = (id, point = center, extra = {}) => ({ id, displayName: { text: `Barber ${id}` }, location: { latitude: point.lat, longitude: point.lng }, rating: 4.7, userRatingCount: 15, businessStatus: 'OPERATIONAL', ...extra });
let calls, handler;
beforeEach(() => {
  db.exec('DELETE FROM scans; DELETE FROM businesses; DELETE FROM api_calls; DELETE FROM api_cache;');
  saveLimits({ monthlySearchLimit: 0, dailySearchLimit: 0, cacheHours: 72 });
  calls = []; handler = () => ({ places: [] });
  globalThis.fetch = async (url, options) => { assert.equal(String(url), 'https://places.googleapis.com/v1/places:searchText'); const body = JSON.parse(options.body); calls.push(body); return response(await handler(body)); };
});
afterEach(async () => { await engine.shutdown(); googlePlacesSource.searchArea = originalSearch; globalThis.fetch = originalFetch; });
async function settled(id) {
  for (let tries = 0; tries < 400; tries++) { const scan = engine.getScan(id); if (!scan.active) return scan; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Scan did not settle');
}

test('grid covers every part of the boundary without gaps before density checks', () => {
  const plan = buildSearchPlan(bounds, 1);
  assert.equal(plan.count, 4);
  assert.equal(plan.cells[0].south, bounds.south); assert.equal(plan.cells.at(-1).north, bounds.north);
  let total = 0;
  for (const cell of plan.cells) total += (cell.north - cell.south) * (cell.east - cell.west);
  assert.ok(Math.abs(total - (bounds.north - bounds.south) * (bounds.east - bounds.west)) < 1e-12);
  assert.equal(plan.cells[0].east, plan.cells[1].west); assert.equal(plan.cells[0].north, plan.cells[2].south);
  assert.throws(() => buildSearchPlan({ ...bounds, west: 180, east: -180 }), /date line/);
  assert.throws(() => buildSearchPlan({ south: -80, west: -170, north: 80, east: 170 }), /smaller area/);
  assert.throws(() => buildSearchPlan(bounds, NaN));
});
test('radius uses geographic distance and excludes rectangle corners and missing coordinates', () => {
  const b = radiusBounds(center, 1), area = { center, bounds: b, radiusKm: 1 };
  assert.ok(insideSearchArea(center, area));
  assert.ok(Math.abs(distanceKm(center, { lat: b.north, lng: center.lng }) - 1) < 1e-8);
  assert.equal(insideSearchArea({ lat: b.north, lng: b.east }, area), false);
  assert.equal(insideSearchArea({ lat: null, lng: null }, area), false);
});
test('lead filters enforce evidence, review range, status, phone and website type', () => {
  const place = { rating: 4.7, reviewCount: 15, businessStatus: 'OPERATIONAL', phoneIntl: '+923001234567' };
  const filters = normalizeLeadFilters({ minRating: 4.5, minReviews: 5, maxReviews: 50, phoneOnly: true, website: 'missing' });
  assert.equal(leadFilterReason(place, filters), null);
  assert.equal(leadFilterReason({ ...place, rating: null }, filters), 'rating');
  assert.equal(leadFilterReason({ ...place, reviewCount: null }, filters), 'reviews');
  assert.equal(leadFilterReason({ ...place, reviewCount: 100 }, filters), 'reviews');
  assert.equal(leadFilterReason({ ...place, phoneIntl: null }, filters), 'phone');
  assert.equal(leadFilterReason({ ...place, businessStatus: 'CLOSED_TEMPORARILY' }, filters), 'listing_status');
  assert.equal(leadFilterReason({ ...place, website: 'https://facebook.com/barber' }, normalizeLeadFilters({ website: 'social' })), null);
  assert.equal(leadFilterReason({ ...place, website: 'https://facebook.com.attacker.invalid' }, normalizeLeadFilters({ website: 'social' })), 'website');
  assert.throws(() => normalizeLeadFilters({ minReviews: 50, maxReviews: 10 }), /Maximum reviews/);
});
test('whole-area search visits all initial cells even with few results and a one-lead target; duplicates collapse', async () => {
  handler = body => {
    const b = body.locationRestriction.rectangle;
    return { places: [googlePlace(`${b.low.latitude}:${b.low.longitude}`), googlePlace('same-business')] };
  };
  const created = await engine.createScan(base), scan = await settled(created.id);
  assert.equal(scan.status, 'completed'); assert.equal(calls.length, 4);
  assert.equal(new Set(calls.map(body => JSON.stringify(body.locationRestriction))).size, 4);
  assert.equal(scan.stats.discovered, 5); assert.equal(scan.stats.coveragePercent, 100);
  assert.equal(engine.scanCoverage(scan.id).length, 4);
});
test('per-page budget saves results and next token; resume continues without repeating saved pages', async () => {
  handler = body => body.pageToken ? { places: [googlePlace('second')]} : { places: [googlePlace('first')], nextPageToken: 'page-two' };
  const one = { ...bounds, north: 31.504, east: 74.304 };
  const p = { lat: 31.502, lng: 74.302 };
  handler = body => body.pageToken ? { places: [googlePlace('second', p)] } : { places: [googlePlace('first', p)], nextPageToken: 'page-two' };
  const created = await engine.createScan({ ...base, bounds: one, maxApiCalls: 1 });
  let scan = await settled(created.id);
  assert.equal(scan.status, 'paused'); assert.equal(scan.stats.discovered, 1); assert.equal(scan.stats.billedCalls, 1);
  assert.equal(scan.stats.coveragePercent, 0);
  assert.equal(db.prepare('SELECT page_token FROM tiles WHERE scan_id=?').get(scan.id).page_token, 'page-two');
  engine.resumeScan(scan.id, { maxApiCalls: 2 }); scan = await settled(scan.id);
  assert.equal(scan.status, 'completed'); assert.equal(scan.stats.discovered, 2);
  assert.equal(calls.length, 2); assert.equal(calls[1].pageToken, 'page-two');
});
test('two workers cannot exceed one remaining uncached request; all areas resume', async () => {
  handler = async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { places: [] }; };
  const created = await engine.createScan({ ...base, maxApiCalls: 1 });
  let scan = await settled(created.id);
  assert.equal(scan.status, 'paused'); assert.equal(scan.stats.billedCalls, 1); assert.equal(calls.length, 1);
  assert.equal(scan.stats.areasDone, 1); assert.equal(scan.stats.tilesPending, 3);
  engine.resumeScan(scan.id, { maxApiCalls: 4 }); scan = await settled(scan.id);
  assert.equal(scan.status, 'completed'); assert.equal(scan.stats.areasDone, 4); assert.equal(calls.length, 4);
});
test('radius overrides the city viewport and rejects out-of-circle results before adding leads', async () => {
  const resolved = googlePlace('location', center, { viewport: { low: { latitude: 31, longitude: 74 }, high: { latitude: 32, longitude: 75 } } });
  handler = body => body.locationRestriction ? { places: [googlePlace('inside'), googlePlace('outside', { lat: center.lat + 0.008, lng: center.lng + 0.009 }), googlePlace('no-location', center, { location: null })] } : { places: [resolved] };
  const preview = await engine.previewArea({ ...base, bounds: undefined, coverageMode: 'radius', radiusKm: 1, cellKm: 2 });
  assert.equal(preview.radiusKm, 1); assert.ok(preview.bounds.north - preview.bounds.south < 0.02);
  const created = await engine.createScan({ ...base, bounds: undefined, coverageMode: 'radius', radiusKm: 1, cellKm: 2 });
  const scan = await settled(created.id);
  assert.equal(scan.stats.discovered, 1); assert.equal(scan.stats.excluded, 2);
});
test('dense cells subdivide and unresolved caps remain visible at minimum area size', async () => {
  const one = { ...bounds, north: 31.502, east: 74.302 };
  const point = { lat: 31.501, lng: 74.301 };
  handler = body => ({ places: Array.from({ length: 20 }, (_, i) => googlePlace(`dense-${body.pageToken || 'one'}-${i}`, point)), nextPageToken: body.pageToken === 'three' ? undefined : body.pageToken ? 'three' : 'two' });
  const created = await engine.createScan({ ...base, bounds: one }), scan = await settled(created.id);
  assert.equal(scan.stats.cappedAreas, 1); assert.match(scan.stats.note, /result cap/);
  assert.equal(scan.stats.discovered, 60);
});
test('lead filters run before CRM insertion and new-only respects existing canonical records', async () => {
  const old = db.prepare('INSERT INTO scans(created_at,updated_at,status,config) VALUES(?,?,?,?)').run(1,1,'completed','{}').lastInsertRowid;
  upsertPlace({ sourceId: 'old', name: 'Barber existing', lat: center.lat, lng: center.lng, phoneIntl: '+923001234567', businessStatus: 'OPERATIONAL', hours: null }, { scanId: Number(old), countryCode: 'PK', categoryValue: 'medium' });
  handler = () => ({ places: [googlePlace('good'), googlePlace('rating-low', center, { rating: 2 }), googlePlace('old'), googlePlace('new-id', center, { displayName: { text: 'Barber existing' }, internationalPhoneNumber: '+923001234567' })] });
  const created = await engine.createScan({ ...base, filters: { minRating: 4, maxReviews: 50, newOnly: true } });
  const scan = await settled(created.id);
  assert.equal(scan.stats.discovered, 1); assert.equal(scan.stats.excluded, 3);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM businesses WHERE place_id='rating-low'").get().n, 0);
});
test('failed areas cannot produce a completed-coverage claim and can be retried', async () => {
  googlePlacesSource.searchArea = async () => { throw Object.assign(new Error('Provider unavailable'), { fatal: true }); };
  const created = await engine.createScan(base), scan = await settled(created.id);
  assert.equal(scan.status, 'failed'); assert.ok(scan.stats.tilesFailed > 0); assert.equal(scan.stats.coveragePercent, 0);
  googlePlacesSource.searchArea = originalSearch;
  engine.resumeScan(scan.id); const resumed = await settled(scan.id);
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.stats.tilesFailed, 0);
});
test('only one scan can start during an asynchronous location lookup', async () => {
  handler = async body => { if (!body.locationRestriction) { await new Promise(resolve => setTimeout(resolve, 30)); return { places: [googlePlace('location', center)] }; } return { places: [] }; };
  const first = engine.createScan({ ...base, bounds: undefined });
  await assert.rejects(engine.createScan({ ...base, bounds: undefined }), /already starting/);
  const created = await first; await settled(created.id);
});

test('crowded initial cells split into four smaller areas, with parent excluded from final coverage', async () => {
  const one = { ...bounds, north: 31.506, east: 74.306 }, point = { lat: 31.503, lng: 74.303 };
  handler = body => {
    const rectangle = body.locationRestriction.rectangle;
    if (rectangle.high.latitude - rectangle.low.latitude < 0.004) return { places: [googlePlace('child', point)] };
    return { places: Array.from({ length: 20 }, (_, i) => googlePlace(`parent-${body.pageToken || 'one'}-${i}`, point)), nextPageToken: body.pageToken === 'three' ? undefined : body.pageToken ? 'three' : 'two' };
  };
  const created = await engine.createScan({ ...base, bounds: one }), scan = await settled(created.id);
  assert.equal(scan.status, 'completed'); assert.equal(scan.stats.tilesTotal, 5); assert.equal(scan.stats.areasTotal, 4);
  assert.equal(scan.stats.cappedAreas, 0); assert.equal(scan.stats.coveragePercent, 100);
  assert.equal(engine.scanCoverage(scan.id).length, 4); assert.equal(calls.length, 7);
});

test('lead target pauses incomplete coverage and a higher target resumes it', async () => {
  handler = body => ({ places: [googlePlace(JSON.stringify(body.locationRestriction))] });
  const created = await engine.createScan({ ...base, completionMode: 'target', targetCount: 1 }), scan = await settled(created.id);
  assert.equal(scan.status, 'paused'); assert.ok(scan.stats.tilesPending > 0); assert.ok(scan.stats.coveragePercent < 100);
  engine.resumeScan(scan.id, { targetCount: 50 });
  assert.equal((await settled(scan.id)).status, 'completed');
});

test('starting a radius search pins the previewed centre without a second location lookup', async () => {
  const created = await engine.createScan({ ...base, bounds: undefined, center, radiusKm: 1, coverageMode: 'radius', cellKm: 2 });
  const scan = await settled(created.id);
  assert.deepEqual(scan.area.center, center);
  assert.ok(calls.every(body => Boolean(body.locationRestriction)));
  await assert.rejects(engine.createScan({ ...base, coverageMode: 'radius', center: { lat: null, lng: null } }), /radius/);
  await assert.rejects(engine.createScan({ ...base, bounds: { ...bounds, south: null } }), /coordinates/);
});
