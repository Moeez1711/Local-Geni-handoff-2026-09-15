import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { toXlsx } from './export.js';

test('ExcelJS resolves the patched CommonJS UUID and round-trips extended data bars, numbers and Unicode in memory', async () => {
  const require = createRequire(import.meta.url);
  const excelRequire = createRequire(require.resolve('exceljs'));
  assert.equal(excelRequire('uuid/package.json').version, '11.1.1');
  assert.match(excelRequire('uuid').v4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Leads');
  sheet.addRows([['Business', 'Score'], ['Café کراچی — 東京', 87.5], ['Studio München', -12], ['Clínica São Paulo', 0]]);
  sheet.addConditionalFormatting({ ref: 'B2:B4', rules: [{ type: 'dataBar', gradient: false, border: true,
    cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF0071E3' }, borderColor: { argb: 'FF004080' },
    negativeFillColor: { argb: 'FFFF3B30' }, negativeBarColorSameAsPositive: false,
  }] });
  const buffer = await book.xlsx.writeBuffer();
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  // Extended data bars execute ExcelJS's actual cf-rule-ext-xform UUID call.
  const extendedIds = [...xml.matchAll(/<x14:cfRule[^>]*\bid="\{([0-9A-F-]+)\}"/g)].map((match) => match[1]);
  assert.equal(extendedIds.length, 1);
  assert.match(extendedIds[0], /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
  assert.match(xml, /<x14:dataBar[^>]*gradient="0"/);
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(buffer);
  const output = restored.getWorksheet('Leads');
  assert.equal(output.getCell('A2').value, 'Café کراچی — 東京');
  assert.equal(output.getCell('A4').value, 'Clínica São Paulo');
  assert.deepEqual(['B2', 'B3', 'B4'].map((cell) => output.getCell(cell).value), [87.5, -12, 0]);
  const rule = output.conditionalFormattings.flatMap((format) => format.rules).find((item) => item.type === 'dataBar');
  assert.ok(rule); assert.equal(rule.gradient, false);
});

test('Local Geni XLSX export still preserves lead values and escapes formula text after the scoped dependency update', async () => {
  const rows = [{ place_id: 'dependency-test', name: 'Café کراچی', score: 82.5, tier: 'hot', category: 'Café',
    phone_intl: '+14165550123', whatsapp: '+14165550123', emails: ['owner@example.com'], website: 'https://example.com',
    rating: 4.8, review_count: 120, notes: '=HYPERLINK("https://example.com")', lead_status: 'not_contacted',
    site_status: 'none', reasons: [], socials: {} }];
  const buffer = await toXlsx(rows);
  const restored = new ExcelJS.Workbook(); await restored.xlsx.load(buffer);
  const sheet = restored.getWorksheet('Leads');
  assert.equal(sheet.getCell('B2').value, 82.5);
  assert.equal(sheet.getCell('C2').value, 'Café کراچی');
  assert.equal(sheet.getCell('E2').value, '+14165550123');
  assert.equal(sheet.getCell('V2').value, '\'=HYPERLINK("https://example.com")');
  assert.equal(restored.creator, 'Local Geni');
});
