/** Refresh the bundled fallback from Google's official Table A. No API key needed. */
import { writeFile } from 'node:fs/promises';
import { load } from 'cheerio';

const source = 'https://developers.google.com/maps/documentation/places/web-service/place-types?hl=en';
const response = await fetch(source, { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Google documentation returned ${response.status}`);
const $ = load(await response.text());
const rows = [];
let group = '';
$('#table-a').nextUntil('#table-b').find('th, code').each((_, node) => {
  if (node.tagName === 'th') { group = $(node).text().trim(); return; }
  if (node.tagName !== 'code') return;
  const type = $(node).text().trim();
  if (!/^[a-z][a-z_0-9]+$/.test(type)) return;
  rows.push({ type, group });
});
const unique = [...new Map(rows.map(row => [row.type, row])).values()];
if (unique.length < 250 || unique.some(row => !row.group) || new Set(unique.map(row => row.group)).size < 15) throw new Error('Google changed the page structure; review before replacing the snapshot.');
const snapshot = { source, retrievedAt: new Date().toISOString(), attribution: 'Google Maps Platform, Place Types, Table A. Documentation licensed CC BY 4.0.', types: unique };
await writeFile(new URL('../server/place-types.json', import.meta.url), `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Bundled ${unique.length} official place types across ${new Set(unique.map(row => row.group)).size} groups.`);
