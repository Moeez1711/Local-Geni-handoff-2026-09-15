/**
 * Lead source registry. To add another data source (e.g. OSM/Overpass, Yelp, a CSV import),
 * implement the same contract as googlePlaces.js and register it here:
 *   resolveArea({ area, countryName, regionCode, radiusKm }, { scanId, signal })
 *     -> { name, address, center:{lat,lng}, bounds:{south,west,north,east} }
 *   searchArea({ textQuery, bounds, regionCode }, { scanId, signal })
 *     -> { places: NormalizedPlace[], pages, saturated }
 * The scan engine only ever talks to this interface.
 */
import { googlePlacesSource } from './googlePlaces.js';

const sources = { [googlePlacesSource.id]: googlePlacesSource };
export const getSource = (id = 'google_places') => {
  const s = sources[id];
  if (!s) throw new Error(`Unknown lead source: ${id}`);
  return s;
};
