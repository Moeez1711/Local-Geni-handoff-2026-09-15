import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { inflateRawSync } from 'node:zlib';
import express from 'express';
process.env.DB_PATH = ':memory:';
process.env.PORT = '4000';
const { db } = await import('./db.js');
const { config } = await import('./config.js');
const { getLead, trashLeads } = await import('./repo.js');
const previews = await import('./previewRepo.js');
const { createPreviewFileService, archiveHtmlFiles, MAX_HTML_BYTES } = await import('./previewFiles.js');
const { createPreviewFilesRouter } = await import('./routes/previewFiles.js');
const { requireLocalEmailOrigin } = await import('./routes/email.js');
const service = createPreviewFileService();
let serial = 0, server, base;
function lead(name = 'Fictional business') { const id = `finished-html-${++serial}`; db.prepare("INSERT INTO businesses(place_id,name,notes,site_status,first_seen,last_seen) VALUES(?,?,?,'none',1,1)").run(id, name, 'Private CRM note must stay private'); return id; }
const html = text => Buffer.from(`<!doctype html>\r\n<html><head><meta charset="UTF-8"></head><body>${text}</body></html>`, 'utf8');
const upload = (id, bytes, filename = 'homepage.html') => service.save(id, { filename, contentBase64: bytes.toString('base64') });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function readZip(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0); const count = bytes.readUInt16LE(end + 10); let offset = bytes.readUInt32LE(end + 16); const files = [];
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const method = bytes.readUInt16LE(offset + 10), compressedSize = bytes.readUInt32LE(offset + 20), nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + compressedSize);
    files.push({ name, bytes: method === 8 ? inflateRawSync(compressed) : compressed }); offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
before(async () => {
  const app = express(); app.use(requireLocalEmailOrigin); app.use(express.json({ limit: '5mb' })); app.use('/api/preview-files', createPreviewFilesRouter(service));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.status ? err.message : 'File operation failed' }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); config.port = server.address().port; base = `http://127.0.0.1:${config.port}`;
});
after(async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });

test('finished HTML is saved and downloaded byte-for-byte with scripts, BOM, Unicode and external assets unchanged', () => {
  const id = lead(); const source = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), html('<script>window.privateScript="keep exactly"</script><img src="https://assets.invalid/photo.png"><p>café سلام</p>')]);
  const before = getLead(id); const result = upload(id, source);
  assert.equal(result.current.sha256, hash(source)); assert.equal(result.current.size, source.length); assert.equal(result.current.revision, 1);
  assert.deepEqual(service.download(id).bytes, source); assert.deepEqual(getLead(id), before);
  assert.doesNotMatch(JSON.stringify(result), /privateScript|assets.invalid|Private CRM note/);
  assert.ok(previews.listPreviews().rows.some(row => row.place_id === id)); assert.equal(previews.getPreview(id).preview.publicUrl, ''); assert.equal(previews.getPreview(id).preview.stage, 'shortlisted');
});

test('saving finished files preserves every existing project field and never injects private notes into downloads', () => {
  const id = lead(); previews.savePreview(id, { publicUrl: 'https://designs.localgeni.app/saved', stage: 'won', brief: 'Keep this private proposal', improvements: ['Existing pitch note'], dealValue: 1200 });
  db.prepare("UPDATE lead_previews SET share_token='legacy-private-token',snapshot_json='{\"legacy\":true}' WHERE place_id=?").run(id);
  const previous = { ...db.prepare('SELECT * FROM lead_previews WHERE place_id=?').get(id) };
  const source = html('Authored page only'); upload(id, source);
  assert.deepEqual({ ...db.prepare('SELECT * FROM lead_previews WHERE place_id=?').get(id) }, previous);
  assert.deepEqual(service.download(id).bytes, source);
  assert.doesNotMatch(service.download(id).bytes.toString('utf8'), /private proposal|legacy-private-token|Existing pitch note|1200/);
});

test('new files create immutable versions and retrying an identical upload does not create a duplicate', () => {
  const id = lead(), first = html('first'), second = html('second'); const a = upload(id, first); const b = upload(id, second);
  assert.equal(b.current.revision, 2); assert.equal(b.versions.length, 2); assert.deepEqual(service.download(id, a.current.id).bytes, first);
  const repeated = upload(id, second); assert.equal(repeated.unchanged, true); assert.equal(repeated.current.id, b.current.id); assert.equal(repeated.versions.length, 2);
});

test('upload validation is atomic for invalid UTF-8, malformed base64, empty, non-HTML and oversized files', () => {
  const id = lead(); const valid = upload(id, html('kept'));
  const invalid = [
    { filename: 'page.html', contentBase64: 'not base64' },
    { filename: 'page.html', contentBase64: Buffer.from([0xc3, 0x28]).toString('base64') },
    { filename: 'page.html', contentBase64: '' },
    { filename: 'page.txt', contentBase64: html('wrong extension').toString('base64') },
    { filename: 'page.html\r\nSet-Cookie: bad=1', contentBase64: html('bad name').toString('base64') },
    { filename: 'page.html', contentBase64: Buffer.from('not an HTML page').toString('base64') },
    { filename: 'page.html', contentBase64: Buffer.alloc(MAX_HTML_BYTES + 1, 65).toString('base64') },
  ];
  for (const body of invalid) assert.throws(() => service.save(id, body), err => err.status === 400 || err.status === 413);
  assert.equal(service.detail(id).current.id, valid.current.id); assert.equal(service.detail(id).versions.length, 1);
});

test('maximum-size valid HTML is accepted and path-like filenames become safe attachment basenames', () => {
  const id = lead(); const prefix = Buffer.from('<!doctype html><html>'); const bytes = Buffer.concat([prefix, Buffer.alloc(MAX_HTML_BYTES - prefix.length - 7, 32), Buffer.from('</html>')]);
  const result = upload(id, bytes, '../../folder\\page"name.htm');
  assert.equal(result.current.size, MAX_HTML_BYTES); assert.equal(result.current.filename, 'page-name.html'); assert.deepEqual(service.download(id).bytes, bytes);
});

test('file versions cannot cross business boundaries and Trash excludes every file operation without erasing files', () => {
  const a = lead(), b = lead(), bytes = html('recoverable'); const saved = upload(a, bytes);
  assert.throws(() => service.download(b, saved.current.id), err => err.status === 404);
  trashLeads([a]);
  for (const call of [() => service.detail(a), () => service.download(a), () => upload(a, html('blocked'))]) assert.throws(call, err => err.status === 404);
  assert.throws(() => service.zipFiles({ placeIds: [a] }), err => err.status === 409);
  trashLeads([a], true); assert.deepEqual(service.download(a).bytes, bytes); assert.equal(service.detail(a).versions.length, 1);
});

test('ZIP exports contain only exact latest files with unique safe names and no CRM metadata', async () => {
  const a = lead('Private business label'), b = lead(); upload(a, html('old')); const bytesA = html('<script>keepA()</script>'), bytesB = html('<img src="image.png">');
  upload(a, bytesA, 'same.html'); upload(b, bytesB, 'same.html');
  const bundle = service.zipFiles({ placeIds: [a, b, a] }); assert.equal(bundle.files.length, 2);
  const archive = archiveHtmlFiles(bundle.files), chunks = [];
  archive.on('data', chunk => chunks.push(chunk)); const completed = once(archive, 'end'); await archive.finalize(); await completed;
  const restored = readZip(Buffer.concat(chunks)); assert.deepEqual(restored.map(file => file.name), ['01-private-business-label-same.html', '02-fictional-business-same.html']);
  assert.deepEqual(restored[0].bytes, bytesA); assert.deepEqual(restored[1].bytes, bytesB);
  assert.doesNotMatch(Buffer.concat(chunks).toString('utf8'), /Private business label|Private CRM note/);
});

test('ZIP exports fail clearly for missing files, selection limits, and totals above 25 MB', () => {
  const a = lead(), missing = lead('Missing finished page'); upload(a, html('available'));
  assert.throws(() => service.zipFiles({ placeIds: [a, missing] }), err => err.status === 409 && /Missing finished page/.test(err.message));
  for (const placeIds of [[], Array(26).fill(a), [''], [null]]) assert.throws(() => service.zipFiles({ placeIds }), err => err.status === 400);
  const body = html('x'.repeat(MAX_HTML_BYTES - 200)); const ids = Array.from({ length: 9 }, () => lead()); ids.forEach(id => upload(id, body));
  assert.throws(() => service.zipFiles({ placeIds: ids }), err => err.status === 413 && /25 MB/.test(err.message));
});

test('HTTP downloads force opaque attachments with sandbox, no-store and nosniff; hostile origins are rejected', async () => {
  const id = lead(), bytes = html('<script>window.executed=true</script>'); const saved = upload(id, bytes);
  const response = await fetch(`${base}/api/preview-files/${id}/download`);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /^application\/octet-stream/); assert.equal(response.headers.get('content-disposition'), 'attachment; filename="homepage.html"');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.match(response.headers.get('content-security-policy'), /sandbox/); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-sha256'), saved.current.sha256);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const rejected = await fetch(`${base}/api/preview-files/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' }, body: JSON.stringify({ filename: 'bad.html', contentBase64: html('blocked').toString('base64') }) });
  assert.equal(rejected.status, 403); assert.equal(service.detail(id).versions.length, 1);
  const zipped = await fetch(`${base}/api/preview-files/export-zip`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ placeIds: [id] }) });
  assert.equal(zipped.status, 200); assert.equal(zipped.headers.get('x-exported-files'), '1'); assert.match(zipped.headers.get('content-disposition'), /finished-homepages.zip/); assert.deepEqual(readZip(Buffer.from(await zipped.arrayBuffer()))[0].bytes, bytes);
});
