const EARTH_KM = 6371.0088;
const rad = value => value * Math.PI / 180;
const deg = value => value * 180 / Math.PI;
const invalid = message => Object.assign(new Error(message), { status: 400 });

export function validBounds(bounds) {
  if (!bounds) throw invalid('Preview a location or choose a search boundary.');
  if (['south', 'west', 'north', 'east'].some(key => bounds[key] == null || bounds[key] === '')) throw invalid('Enter all four search boundary coordinates.');
  const [south, west, north, east] = ['south', 'west', 'north', 'east'].map(key => Number(bounds[key]));
  if (![south, west, north, east].every(Number.isFinite) || south >= north || west >= east || south < -85 || north > 85 || west < -180 || east > 180) {
    throw invalid('Choose a smaller boundary between 85° south and north that does not cross the date line.');
  }
  return { south, west, north, east };
}

export function radiusBounds(center, radiusKm) {
  if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng) || !Number.isFinite(radiusKm) || radiusKm < 0.5 || radiusKm > 50) throw invalid('Choose a radius between 0.5 and 50 km.');
  const latitude = deg(radiusKm / EARTH_KM);
  const longitude = deg(Math.asin(Math.sin(radiusKm / EARTH_KM) / Math.cos(rad(center.lat))));
  return validBounds({ south: center.lat - latitude, north: center.lat + latitude, west: center.lng - longitude, east: center.lng + longitude });
}

export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function insideSearchArea(place, area) {
  if (place.lat == null || place.lng == null || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return false;
  const b = area.bounds;
  if (place.lat < b.south || place.lat > b.north || place.lng < b.west || place.lng > b.east) return false;
  return !area.radiusKm || distanceKm(area.center, place) <= area.radiusKm + 0.000001;
}

/** Uniform, contiguous cells cover the selected rectangle before any density-based subdivision. */
export function buildSearchPlan(bounds, cellKm = 1) {
  const b = validBounds(bounds);
  if (!Number.isFinite(cellKm) || cellKm < 0.5 || cellKm > 5) throw invalid('Choose a search area size between 0.5 and 5 km.');
  const nearestEquator = b.south <= 0 && b.north >= 0 ? 0 : Math.min(Math.abs(b.south), Math.abs(b.north));
  const heightKm = rad(b.north - b.south) * EARTH_KM;
  const widthKm = rad(b.east - b.west) * EARTH_KM * Math.cos(rad(nearestEquator));
  const rows = Math.max(1, Math.ceil(heightKm / cellKm)), columns = Math.max(1, Math.ceil(widthKm / cellKm));
  const count = rows * columns;
  if (count > 10000) throw invalid(`This boundary needs ${count.toLocaleString()} search areas. Choose a smaller area or increase the area size.`);
  const cells = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    cells.push({ south: b.south + (b.north - b.south) * row / rows, north: b.south + (b.north - b.south) * (row + 1) / rows,
      west: b.west + (b.east - b.west) * col / columns, east: b.west + (b.east - b.west) * (col + 1) / columns });
  }
  return { rows, columns, count, cellKm, widthKm, heightKm, cells };
}

export const DEFAULT_LEAD_FILTERS = { minRating: 0, minReviews: 0, maxReviews: '', phoneOnly: false, website: 'any', status: 'exclude_closed', newOnly: false };

export function normalizeLeadFilters(input = {}) {
  const value = { ...DEFAULT_LEAD_FILTERS, ...input };
  for (const [key, max] of [['minRating', 5], ['minReviews', 10000000], ['maxReviews', 10000000]]) {
    if (key === 'maxReviews' && (value[key] === '' || value[key] == null)) { value[key] = null; continue; }
    value[key] = Number(value[key]);
    if (!Number.isFinite(value[key]) || value[key] < 0 || value[key] > max || (key !== 'minRating' && !Number.isInteger(value[key]))) throw invalid('Enter valid rating and review filters.');
  }
  if (value.maxReviews != null && value.maxReviews < value.minReviews) throw invalid('Maximum reviews must be at least the minimum reviews.');
  if (!['any', 'missing', 'social', 'present'].includes(value.website) || !['any', 'exclude_closed', 'operational'].includes(value.status)) throw invalid('Choose valid lead filters.');
  value.phoneOnly = value.phoneOnly === true; value.newOnly = value.newOnly === true;
  return value;
}

export function leadFilterReason(place, filters) {
  if (filters.status === 'operational' && place.businessStatus !== 'OPERATIONAL') return 'listing_status';
  if (filters.status === 'exclude_closed' && ['CLOSED_PERMANENTLY', 'CLOSED_TEMPORARILY'].includes(place.businessStatus)) return 'listing_status';
  if (filters.minRating > 0 && (place.rating == null || place.rating < filters.minRating)) return 'rating';
  if ((filters.minReviews > 0 || filters.maxReviews != null) && (place.reviewCount == null || place.reviewCount < filters.minReviews || (filters.maxReviews != null && place.reviewCount > filters.maxReviews))) return 'reviews';
  if (filters.phoneOnly && !place.phoneIntl && !place.phoneNational) return 'phone';
  let host = ''; try { host = new URL(place.website).hostname.toLowerCase().replace(/^www\./, ''); } catch { /* no usable URL */ }
  const social = ['facebook.com', 'instagram.com', 'tiktok.com', 'linkedin.com', 'wa.me', 'whatsapp.com'].some(domain => host === domain || host.endsWith(`.${domain}`));
  if (filters.website === 'missing' && place.website) return 'website';
  if (filters.website === 'social' && !social) return 'website';
  if (filters.website === 'present' && (!host || social)) return 'website';
  return null;
}
