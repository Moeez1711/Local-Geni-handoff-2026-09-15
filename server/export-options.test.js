import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { toCsv, toXlsx, exportPreview, exportSelection, exportColumnMetadata } from './export.js';
const rows = [{ place_id: 'qa-export', name: 'Café کراچی', phone_e164: '+14165550123', emails: ['owner@example.com'], socials: {}, notes: '=HYPERLINK("https://example.com")', score: 78, tier: 'hot' }];
test('preview, CSV and XLSX use selected columns in the same order, including custom fields', async () => {
  const options = { columns: ['lead:2', 'lead:4', 'custom:qa-owner', 'lead:21'], customFields: [{ id: 'qa-owner', label: 'Owner', type: 'text' }], customValues: { 'qa-export': { 'qa-owner': 'Example owner' } } };
  const preview = exportPreview(rows, options); assert.deepEqual(preview.columns.map(row => row.id), options.columns);
  assert.equal(preview.rows[0][1], '+14165550123'); assert.equal(preview.rows[0][2], 'Example owner');
  const csv = toCsv(rows, options); assert.ok(csv.startsWith('\uFEFFBusiness,Phone,Custom: Owner [qa-owner],Notes'));
  assert.match(csv, /Café کراچی/); assert.match(csv, /'=/);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await toXlsx(rows, options));
  const sheet = workbook.getWorksheet('Leads'); assert.equal(sheet.columnCount, 4); assert.equal(sheet.getCell('A2').value, preview.rows[0][0]); assert.equal(sheet.getCell('B2').value, preview.rows[0][1]); assert.equal(sheet.getCell('C2').value, 'Example owner'); assert.equal(sheet.getCell('D2').value, `'${rows[0].notes}`);
});
test('empty selected IDs cannot become an all-business export; filters export every page and invalid columns fail', () => {
  assert.equal(exportSelection({ ids: [] }).empty, true);
  assert.equal(exportSelection({ filters: { offset: 100, tier: 'hot' } }).filters.offset, 0);
  assert.equal(exportSelection({ ids: ['one'], filters: { sort: 'name', dir: 'asc' } }).filters.sort, 'name');
  assert.throws(() => exportSelection({ ids: 'not-an-array' }));
  for (const columns of [[], ['lead:2', 'lead:2'], ['secret'], ['custom:archived']]) assert.throws(() => toCsv(rows, { columns }));
  assert.equal(exportColumnMetadata({ customFields: [{ id: 'old', archived: true }] }).length, 26);
});
