/**
 * Usage limits and cost estimates for billable Google business searches (Text Search Enterprise).
 * Limits are stored in the settings table and enforced in the provider before every non-cached search.
 */
import { config } from './config.js';
import { db } from './db.js';
import { getSettings, saveSettings } from './repo.js';

export const LIMIT_DEFAULTS = {
  monthlySearchLimit: 1000, // Google's free monthly allowance for Text Search Enterprise
  dailySearchLimit: 0, // 0 = no daily limit
  defaultScanBudget: 150,
  defaultTargetCount: 100,
  cacheHours: config.cacheTtlMs / 3600_000,
  freeSearchesPerMonth: 1000,
  costPer1000: config.placesCostPer1000,
};

const RULES = {
  monthlySearchLimit: [0, 1_000_000], dailySearchLimit: [0, 100_000], defaultScanBudget: [1, 10_000],
  defaultTargetCount: [1, 5000], cacheHours: [0, 720], freeSearchesPerMonth: [0, 1_000_000], costPer1000: [0, 1000],
};
const DECIMAL = new Set(['cacheHours', 'costPer1000']);

export const getLimits = () => ({ ...LIMIT_DEFAULTS, ...(getSettings().limits || {}) });

export function saveLimits(input = {}) {
  const next = getLimits();
  for (const [k, [lo, hi]] of Object.entries(RULES)) {
    if (input[k] === undefined || input[k] === '' || input[k] === null) continue;
    const n = Number(input[k]);
    if (!Number.isFinite(n) || n < lo || n > hi) throw Object.assign(new Error(`${k} must be between ${lo} and ${hi}`), { status: 400 });
    next[k] = DECIMAL.has(k) ? n : Math.round(n);
  }
  saveSettings({ limits: next });
  return next;
}

const startOfDay = () => new Date().setHours(0, 0, 0, 0);
const startOfMonth = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
const countStmt = db.prepare(`SELECT COUNT(*) n FROM api_calls WHERE provider='google_places' AND endpoint=? AND outcome='ok' AND ts >= ?`);

export function usage() {
  const limits = getLimits();
  const month = countStmt.get('searchText', startOfMonth()).n;
  const today = countStmt.get('searchText', startOfDay()).n;
  const left = (limit, used) => (limit > 0 ? Math.max(0, limit - used) : null);
  return {
    limits,
    searches: { today, month, areaLookupsMonth: countStmt.get('resolveArea', startOfMonth()).n },
    remaining: { today: left(limits.dailySearchLimit, today), month: left(limits.monthlySearchLimit, month) },
    freeLeftThisMonth: Math.max(0, limits.freeSearchesPerMonth - month),
    estMonthCostUsd: Math.round(Math.max(0, month - limits.freeSearchesPerMonth) * limits.costPer1000) / 1000,
  };
}

const limitError = (message) => Object.assign(new Error(message), { code: 'LIMIT', status: 429 });

/** Throws if one more billable search (plus any already in flight) would pass the daily or monthly limit. */
export function assertSearchAllowed(inFlight = 0) {
  const { limits, searches } = usage();
  if (limits.dailySearchLimit > 0 && searches.today + inFlight >= limits.dailySearchLimit) {
    throw limitError(`Daily search limit reached (${searches.today}/${limits.dailySearchLimit}). Raise it in Settings or resume tomorrow.`);
  }
  if (limits.monthlySearchLimit > 0 && searches.month + inFlight >= limits.monthlySearchLimit) {
    throw limitError(`Monthly search limit reached (${searches.month}/${limits.monthlySearchLimit}). Raise it in Settings or resume next month.`);
  }
}
