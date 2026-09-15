import { useEffect, useRef, useState } from 'react';
import { loadMaps, MAP_ID } from '../lib/maps.js';

const same = (a, b) => a && b && ['north', 'south', 'east', 'west'].every((k) => Math.abs(a[k] - b[k]) < 1e-6);

/**
 * Google map showing the scan rectangle (optionally editable) and lead pins coloured by tier.
 * Pins are diffed by place_id so live updates don't rebuild the map.
 */
export default function MapView({ bounds, circle, editable = false, onBoundsChange, points = [], onSelect, height = 380 }) {
  const el = useRef(null);
  const map = useRef(null);
  const rect = useRef(null);
  const radiusCircle = useRef(null);
  const markers = useRef(new Map());
  const lastEmitted = useRef(null);
  const handlers = useRef({});
  handlers.current = { onBoundsChange, onSelect };
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const onFail = () => setError('Google rejected the Maps JavaScript API key (check key restrictions, API enablement and billing).');
    window.addEventListener('maps-auth-failure', onFail);
    loadMaps()
      .then(async (gm) => {
        const [{ Map }] = await Promise.all([gm.importLibrary('maps'), gm.importLibrary('marker')]);
        if (cancelled || !el.current) return;
        map.current = new Map(el.current, {
          center: { lat: 23.588, lng: 58.3829 }, zoom: 11, mapId: MAP_ID,
          disableDefaultUI: true, zoomControl: true, fullscreenControl: true, clickableIcons: false,
        });
        setReady(true);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; window.removeEventListener('maps-auth-failure', onFail); };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const gm = window.google.maps;
    if (!bounds) { rect.current?.setMap(null); rect.current = null; lastEmitted.current = null; return; }
    if (same(bounds, lastEmitted.current)) return; // change came from dragging the rectangle
    let timer;
    if (!rect.current) {
      rect.current = new gm.Rectangle({
        map: map.current, bounds, strokeColor: '#007aff', strokeWeight: 2, fillColor: '#007aff', fillOpacity: 0.08,
      });
      rect.current.addListener('bounds_changed', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const b = rect.current?.getBounds()?.toJSON();
          if (!b || same(b, lastEmitted.current)) return;
          lastEmitted.current = b;
          handlers.current.onBoundsChange?.(b);
        }, 250);
      });
    } else {
      lastEmitted.current = bounds;
      rect.current.setBounds(bounds);
    }
    lastEmitted.current = bounds;
    map.current.fitBounds(bounds, 32);
  }, [ready, bounds]);

  useEffect(() => {
    rect.current?.setOptions({ editable, draggable: editable });
  }, [ready, bounds, editable]);

  useEffect(() => {
    if (!ready) return;
    radiusCircle.current?.setMap(null);
    radiusCircle.current = circle ? new window.google.maps.Circle({ map: map.current, center: circle.center,
      radius: circle.radiusKm * 1000, strokeColor: '#376a9f', strokeWeight: 2, fillColor: '#376a9f', fillOpacity: 0.08, clickable: false }) : null;
    return () => radiusCircle.current?.setMap(null);
  }, [ready, circle?.center?.lat, circle?.center?.lng, circle?.radiusKm]);

  useEffect(() => {
    if (!ready) return;
    const { AdvancedMarkerElement } = window.google.maps.marker;
    const seen = new Set();
    for (const p of points) {
      if (p.lat == null) continue;
      seen.add(p.place_id);
      let m = markers.current.get(p.place_id);
      if (!m) {
        m = new AdvancedMarkerElement({ map: map.current, position: { lat: p.lat, lng: p.lng }, content: document.createElement('div'), title: p.name });
        m.addListener('click', () => handlers.current.onSelect?.(p.place_id));
        markers.current.set(p.place_id, m);
      }
      m.content.className = `pin pin-${p.tier}`;
      m.title = `${p.name} / score ${p.score}`;
      m.zIndex = p.score;
    }
    for (const [id, m] of markers.current) {
      if (!seen.has(id)) { m.map = null; markers.current.delete(id); }
    }
  }, [ready, points]);

  return (
    <div className={`map ${error ? 'map-has-error' : ''}`} style={{ height }}>
      <div ref={el} className="map-canvas" aria-label="Business search area map" />
      {error && <div className="map-overlay map-unavailable" role="status">
        <div className="map-state-icon" aria-hidden="true"><svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m5 10 10-4 10 4 10-4v24l-10 4-10-4-10 4V10ZM15 6v24m10-20v24" /><circle cx="27" cy="13" r="7" fill="var(--panel, #fff)" /><path d="M27 9v5m0 3v.2" /></svg></div>
        <strong>Map preview unavailable</strong>
        <span>Your search settings are ready to explore.<br />Connect Google Maps to preview the area here.</span>
        <details className="map-error-details"><summary>View connection details</summary><p>{error}</p></details>
        <small>The map is optional. Scanning uses your Google Places connection.</small>
      </div>}
      {!ready && !error && <div className="map-overlay subtle" role="status"><span className="map-loading-indicator" aria-hidden="true" /><strong>Finding your bearings...</strong><span>Loading your map preview</span></div>}
      {ready && !error && editable && !bounds && <div className="map-empty-prompt"><strong>Your search area starts here</strong><span>Choose a location, then select Preview area.</span></div>}
    </div>
  );
}
