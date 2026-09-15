/** Stores finished HTML as opaque bytes. Nothing here renders or fetches page content. */
import crypto from 'node:crypto';
import archiver from 'archiver';
import { db } from './db.js';
import './previewRepo.js';

export const MAX_HTML_BYTES = 3 * 1024 * 1024;
export const MAX_ZIP_BYTES = 25 * 1024 * 1024;
export const MAX_ZIP_FILES = 25;
const error = (status, message) => Object.assign(new Error(message), { status });
const metadata = (row) => row ? { id: row.id, placeId: row.place_id, filename: row.filename, size: Number(row.byte_length), sha256: row.sha256, revision: Number(row.revision), createdAt: Number(row.created_at) } : null;
const selectedColumns = 'id,place_id,filename,byte_length,sha256,revision,created_at';
export function safeHtmlFilename(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw error(400, 'Choose an HTML filename of up to 200 characters.');
  const name = value.trim().split(/[\\/]/).at(-1);
  if (!/\.html?$/i.test(name)) throw error(400, 'Choose a .html or .htm file.');
  const stem = name.replace(/\.html?$/i, '').replace(/[^a-zA-Z0-9._ -]/g, '-').replace(/\.{2,}/g, '.').replace(/^[. -]+|[. -]+$/g, '').slice(0, 120);
  return `${stem || 'homepage'}.html`;
}
function decodeHtml(body) {
  const filename = safeHtmlFilename(body?.filename);
  const encoded = body?.contentBase64;
  if (typeof encoded !== 'string' || !encoded.length) throw error(400, 'Choose a non-empty HTML file.');
  if (encoded.length > Math.ceil(MAX_HTML_BYTES / 3) * 4) throw error(413, 'The HTML file must be 3 MB or smaller.');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw error(400, 'The file encoding is invalid. Choose the HTML file again.');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_HTML_BYTES) throw error(413, 'The HTML file must be non-empty and 3 MB or smaller.');
  if (bytes.toString('base64') !== encoded) throw error(400, 'The file encoding is invalid.');
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw error(400, 'Export the finished page as UTF-8 HTML, then choose it again.'); }
  if (!/<(?:!doctype\s+html\b|html\b|head\b|body\b)/i.test(text)) throw error(400, 'Choose a finished HTML page exported from your design system.');
  return { filename, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

export function createPreviewFileService({ database = db, now = Date.now } = {}) {
  database.exec(`CREATE TABLE IF NOT EXISTS finished_preview_files (
    id TEXT PRIMARY KEY, place_id TEXT NOT NULL REFERENCES businesses(place_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, filename TEXT NOT NULL, byte_length INTEGER NOT NULL,
    sha256 TEXT NOT NULL, content BLOB NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(place_id,revision)
  ); CREATE INDEX IF NOT EXISTS idx_finished_preview_files_lead ON finished_preview_files(place_id,revision DESC);`);
  function assertLead(placeId) {
    if (typeof placeId !== 'string' || !placeId || placeId.length > 300 || !database.prepare('SELECT 1 FROM businesses WHERE place_id=? AND deleted_at IS NULL').get(placeId)) throw error(404, 'Business not found.');
  }
  function detail(placeId) {
    assertLead(placeId);
    const versions = database.prepare(`SELECT ${selectedColumns} FROM finished_preview_files WHERE place_id=? ORDER BY revision DESC`).all(placeId).map(metadata);
    return { current: versions[0] || null, versions, maxBytes: MAX_HTML_BYTES };
  }
  function save(placeId, body) {
    assertLead(placeId);
    const file = decodeHtml(body);
    const last = database.prepare(`SELECT ${selectedColumns} FROM finished_preview_files WHERE place_id=? ORDER BY revision DESC LIMIT 1`).get(placeId);
    if (last?.sha256 === file.sha256 && last?.filename === file.filename) return { ...detail(placeId), unchanged: true };
    // All statements are synchronous: deletion or another save cannot interleave this revision write.
    const createdAt = now();
    database.exec('SAVEPOINT finished_preview_upload');
    try {
      database.prepare('INSERT INTO finished_preview_files(id,place_id,revision,filename,byte_length,sha256,content,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(), placeId, Number(last?.revision || 0) + 1, file.filename, file.bytes.length, file.sha256, file.bytes, createdAt);
      database.prepare("INSERT OR IGNORE INTO lead_previews(place_id,stage,draft_json,updated_at) VALUES(?,'shortlisted','{}',?)").run(placeId, createdAt);
      database.exec('RELEASE finished_preview_upload');
    } catch (err) { database.exec('ROLLBACK TO finished_preview_upload; RELEASE finished_preview_upload'); throw err; }
    return detail(placeId);
  }
  function download(placeId, versionId) {
    assertLead(placeId);
    if (versionId !== undefined && (typeof versionId !== 'string' || !/^[a-f0-9-]{36}$/i.test(versionId))) throw error(400, 'Choose a saved file version.');
    const row = versionId ? database.prepare('SELECT * FROM finished_preview_files WHERE place_id=? AND id=?').get(placeId, versionId)
      : database.prepare('SELECT * FROM finished_preview_files WHERE place_id=? ORDER BY revision DESC LIMIT 1').get(placeId);
    if (!row) throw error(404, 'No finished HTML file is saved for this business.');
    return { ...metadata(row), bytes: Buffer.from(row.content) };
  }
  function zipFiles(body) {
    const ids = body?.placeIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_ZIP_FILES || ids.some(id => typeof id !== 'string' || !id || id.length > 300)) throw error(400, `Select between 1 and ${MAX_ZIP_FILES} businesses for a ZIP export.`);
    const unique = [...new Set(ids)];
    const candidates = unique.map(id => database.prepare(`SELECT f.id,f.place_id,f.byte_length FROM finished_preview_files f JOIN businesses b ON b.place_id=f.place_id WHERE f.place_id=? AND b.deleted_at IS NULL ORDER BY f.revision DESC LIMIT 1`).get(id)).filter(Boolean);
    const found = new Set(candidates.map(row => row.place_id));
    const missing = unique.filter(id => !found.has(id));
    if (missing.length) {
      const names = missing.map(id => database.prepare('SELECT name FROM businesses WHERE place_id=? AND deleted_at IS NULL').get(id)?.name?.slice(0, 80) || 'Unavailable or deleted business');
      throw error(409, `No ZIP was exported. Add a finished HTML file for: ${names.join(', ')}.`);
    }
    if (candidates.reduce((sum, row) => sum + Number(row.byte_length), 0) > MAX_ZIP_BYTES) throw error(413, 'These pages exceed the 25 MB ZIP limit. Export fewer businesses at a time.');
    const files = candidates.map(row => ({ ...download(row.place_id, row.id), businessName: database.prepare('SELECT name FROM businesses WHERE place_id=?').get(row.place_id).name }));
    return { files, skipped: unique.length - files.length };
  }
  return { detail, save, download, zipFiles };
}
export function archiveHtmlFiles(files) {
  const archive = archiver('zip', { zlib: { level: 6 } });
  files.forEach((file, index) => {
    const business = String(file.businessName || 'business').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'business';
    archive.append(file.bytes, { name: `${String(index + 1).padStart(2, '0')}-${business}-${file.filename}`, date: new Date(file.createdAt) });
  });
  return archive;
}
export const previewFileService = createPreviewFileService();
