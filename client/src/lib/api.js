async function request(method, url, body, { signal, raw } = {}) {
  const res = await fetch(`/api${url}`, {
    method,
    signal,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let payload = {};
    try { payload = await res.json(); } catch { /* not json */ }
    if (res.status === 401 && payload.code === 'AUTH_REQUIRED') window.dispatchEvent(new Event('local-geni-auth-changed'));
    throw Object.assign(new Error(payload.error || `Request failed (${res.status})`), { status: res.status, code: payload.code });
  }
  if (raw) return res;
  return res.status === 204 ? null : res.json();
}

export const api = {
  get: (url, opts) => request('GET', url, null, opts),
  post: (url, body, opts) => request('POST', url, body || {}, opts),
  patch: (url, body) => request('PATCH', url, body),
  put: (url, body) => request('PUT', url, body),
  del: (url) => request('DELETE', url),
};

export const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== '' && v != null && v !== false) p.set(k, Array.isArray(v) ? v.join(',') : v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** One shared EventSource; auto-reconnects (browser default). */
export function subscribe(onEvent, onStatus) {
  const es = new EventSource('/api/events');
  es.onopen = () => onStatus?.(true);
  es.onerror = () => onStatus?.(false);
  es.onmessage = (m) => { try { onEvent(JSON.parse(m.data)); } catch { /* ignore */ } };
  return () => es.close();
}

export async function download(format, payload) {
  const res = await request('POST', '/export', { format, ...payload }, { raw: true });
  const name = res.headers.get('Content-Disposition')?.match(/filename="(.+)"/)?.[1] || `leads.${format}`;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export const fmt = {
  num: (n) => (n == null ? '-' : Number(n).toLocaleString()),
  ago: (ts) => {
    if (!ts) return '-';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return new Date(ts).toLocaleDateString();
  },
  time: (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  digits: (e164) => (e164 || '').replace(/\D/g, ''),
};

export const TIER_LABEL = { hot: 'Hot Lead', potential: 'Potential', low: 'Low Priority' };
export const LEAD_STATUSES = [
  ['not_contacted', 'Not contacted'], ['contacted', 'Contacted'], ['interested', 'Interested'],
  ['converted', 'Converted'], ['not_interested', 'Not interested'],
];

export function webBadge(lead) {
  const s = lead.site_status;
  if (s === 'none') return ['No website', 'bad'];
  if (s === 'social_only') return ['Social only', 'bad'];
  if (s === 'broken') return ['Broken site', 'bad'];
  if (s === 'pending' || s === 'analyzing') return ['Checking...', 'muted'];
  if (s === 'unknown') return ['Unchecked', 'muted'];
  const d = lead.site?.design?.verdict;
  if (d === 'outdated') return ['Outdated site', 'warn'];
  if (lead.site?.mobile?.verdict === 'unlikely') return ['Not mobile', 'warn'];
  if (d === 'dated') return ['Dated site', 'warn'];
  return ['Modern site', 'good'];
}

export const PAGE_SIZE = 100;
export const DEFAULT_FILTERS = {
  scope: 'scan', q: '', tier: [], web: [], minRating: '', minReviews: '', category: '', trash: false,
  leadStatus: '', contact: '', followUp: '', country: '', searchCategory: '', sort: 'score', dir: 'desc', page: 0,
};
export const leadParams = (f, scanId) => ({
  scanId: f.scope === 'scan' ? scanId : '', q: f.q, tier: f.tier, web: f.web, minRating: f.minRating, trash: f.trash,
  minReviews: f.minReviews, category: f.category, leadStatus: f.leadStatus, contact: f.contact, followUp: f.followUp, country: f.country, searchCategory: f.searchCategory, sort: f.sort, dir: f.dir,
});
