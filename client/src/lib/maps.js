// Loads the Maps JavaScript API once. The browser key should be HTTP-referrer restricted.
let promise;

export function loadMaps() {
  if (promise) return promise;
  const key = import.meta.env.VITE_GOOGLE_MAPS_JS_KEY;
  if (!key) return Promise.reject(new Error('VITE_GOOGLE_MAPS_JS_KEY is not set in .env'));
  promise = new Promise((resolve, reject) => {
    window.__leadScoutMapsReady = () => resolve(window.google.maps);
    window.gm_authFailure = () => window.dispatchEvent(new Event('maps-auth-failure'));
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__leadScoutMapsReady`;
    s.async = true;
    s.onerror = () => { promise = null; reject(new Error('Could not load Google Maps (offline or blocked)')); };
    document.head.appendChild(s);
  });
  return promise;
}

export const MAP_ID = import.meta.env.VITE_GOOGLE_MAP_ID || 'DEMO_MAP_ID';
