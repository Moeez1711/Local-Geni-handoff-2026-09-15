export const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** Spaces calls so no more than `rps` start per second (shared across all scans). */
export function createRateLimiter(rps) {
  const gap = 1000 / Math.max(rps, 0.1);
  let next = 0;
  return async function acquire() {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + gap;
    if (wait) await sleep(wait);
  };
}

/** Minimal promise pool: run(fn) resolves when fn finishes, never more than `n` at once. */
export function createPool(n) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < n && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; pump(); });
    }
  };
  return {
    run: (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); }),
    get size() { return active + queue.length; },
  };
}

export const nameKey = (s = '') => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(llc|l\.l\.c|co|company|est|trading|the)\b/g, '').replace(/[^\p{L}\p{N}]+/gu, '');

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}
