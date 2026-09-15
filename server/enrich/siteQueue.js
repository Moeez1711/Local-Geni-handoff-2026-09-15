/** Background website-analysis queue. Pulls pending sites from the DB so it survives restarts. */
import { config } from '../config.js';
import { emit } from '../events.js';
import * as repo from '../repo.js';
import { sleep } from '../util.js';
import { analyzeWebsite } from './websiteAnalyzer.js';

let active = 0;
let draining = false;

export function kickSites() {
  if (draining || config.websiteConcurrency < 1) return;
  draining = true;
  setImmediate(drain);
}

export const siteQueueState = () => ({ active, draining });

async function drain() {
  try {
    for (;;) {
      const free = config.websiteConcurrency - active;
      if (free <= 0) { await sleep(200); continue; }
      const batch = repo.claimPendingSites(free);
      if (!batch.length) {
        if (active === 0) break;
        await sleep(300);
        continue;
      }
      for (const row of batch) {
        active++;
        analyzeOne(row).finally(() => { active--; });
      }
    }
  } finally {
    draining = false;
  }
}

async function analyzeOne(row) {
  let site;
  try {
    site = repo.cachedSiteFor(row.website_domain) || await analyzeWebsite(row.website);
  } catch (e) {
    site = { status: 'unknown', reason: `Analyzer error: ${e.message}`, checkedAt: Date.now() };
  }
  const lead = repo.applySite(row.place_id, site);
  if (lead) emit('lead:updated', { placeId: lead.place_id, score: lead.score, tier: lead.tier, siteStatus: lead.site_status });
}
