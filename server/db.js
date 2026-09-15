import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  config TEXT NOT NULL,
  area TEXT,
  stats TEXT NOT NULL DEFAULT '{}',
  error TEXT
);

CREATE TABLE IF NOT EXISTS tiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  south REAL, west REAL, north REAL, east REAL,
  depth INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  page_token TEXT,
  pages INTEGER NOT NULL DEFAULT 0,
  results INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_tiles_scan ON tiles(scan_id, status);

CREATE TABLE IF NOT EXISTS businesses (
  place_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT,
  address TEXT,
  lat REAL, lng REAL,
  country_code TEXT,
  phone_national TEXT,
  phone_intl TEXT,
  phone_e164 TEXT,
  phone_type TEXT,
  website TEXT,
  website_domain TEXT,
  rating REAL,
  review_count INTEGER,
  category TEXT,
  category_value TEXT,
  types TEXT,
  business_status TEXT,
  open_now INTEGER,
  hours TEXT,
  maps_url TEXT,
  emails TEXT NOT NULL DEFAULT '[]',
  socials TEXT NOT NULL DEFAULT '{}',
  whatsapp TEXT,
  whatsapp_source TEXT,
  site_status TEXT NOT NULL DEFAULT 'pending',
  site TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'low',
  reasons TEXT NOT NULL DEFAULT '[]',
  lead_status TEXT NOT NULL DEFAULT 'not_contacted',
  notes TEXT NOT NULL DEFAULT '',
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  analyzed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_biz_phone ON businesses(phone_e164, name_key);
CREATE INDEX IF NOT EXISTS idx_biz_domain ON businesses(website_domain, name_key);
CREATE INDEX IF NOT EXISTS idx_biz_score ON businesses(score DESC);

CREATE TABLE IF NOT EXISTS scan_businesses (
  scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  place_id TEXT NOT NULL REFERENCES businesses(place_id) ON DELETE CASCADE,
  found_at INTEGER NOT NULL,
  is_new INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (scan_id, place_id)
);

CREATE TABLE IF NOT EXISTS api_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  scan_id INTEGER,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  outcome TEXT NOT NULL,
  http_code INTEGER,
  ms INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_ts ON api_calls(ts);

CREATE TABLE IF NOT EXISTS api_cache (
  key TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// Additive migrations for databases created by earlier versions.
const tileCols = new Set(db.prepare('PRAGMA table_info(tiles)').all().map(c => c.name));
if (!tileCols.has('parent_id')) db.exec('ALTER TABLE tiles ADD COLUMN parent_id INTEGER');
if (!tileCols.has('saturated')) db.exec('ALTER TABLE tiles ADD COLUMN saturated INTEGER NOT NULL DEFAULT 0');
db.exec(`CREATE INDEX IF NOT EXISTS idx_tiles_parent ON tiles(parent_id);
CREATE TABLE IF NOT EXISTS scan_candidates (
  scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY(scan_id, source_id)
);`);
const bizCols = new Set(db.prepare('PRAGMA table_info(businesses)').all().map((c) => c.name));
for (const col of ['follow_up_at', 'last_contacted_at', 'deleted_at']) {
  if (!bizCols.has(col)) db.exec(`ALTER TABLE businesses ADD COLUMN ${col} INTEGER`);
}
db.exec(`
CREATE INDEX IF NOT EXISTS idx_biz_followup ON businesses(follow_up_at);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// A scan that was "running" when the process died cannot still be running.
db.prepare(`UPDATE scans SET status='interrupted', updated_at=? WHERE status IN ('running','queued')`).run(Date.now());
db.prepare(`UPDATE businesses SET site_status='pending' WHERE site_status='analyzing'`).run();

export const json = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
