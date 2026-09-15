import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseRecipientCsv, normalizeImportedNumber, suggestPhoneColumn, extractPhoneColumn, readRecipientFile, SMS_IMPORT_MAX_BYTES } from './smsImport.js';

test('CSV keeps quoted commas, escaped quotes, multiline values and country prefixes', () => {
  const rows = parseRecipientCsv('\uFEFFName,Phone,Notes\r\n"Acme, Inc",+14165550123,"Said ""hello""\r\nagain"\r\n');
  assert.deepEqual(rows, [['Name','Phone','Notes'],['Acme, Inc','+14165550123','Said "hello"\r\nagain']]);
  assert.deepEqual(suggestPhoneColumn(rows), { column: 1, hasHeader: true });
});
test('CSV handles semicolon, TSV, explicit separator and headerless phone lists', () => {
  for (const separator of [';', '\t']) assert.deepEqual(parseRecipientCsv(`Name${separator}Phone\nA${separator}+14165550123`), [['Name','Phone'],['A','+14165550123']]);
  assert.deepEqual(parseRecipientCsv('sep=;\r\nName;Phone\r\nA;+14165550123'), [['Name','Phone'],['A','+14165550123']]);
  const rows = parseRecipientCsv('+14165550123\n+14165550124');
  assert.deepEqual(suggestPhoneColumn(rows), { column: 0, hasHeader: false });
  assert.equal(extractPhoneColumn(rows, 0, false).numbers.length, 2);
});
test('CSV rejects damaged quotes and oversized row or column counts', () => {
  assert.throws(() => parseRecipientCsv('Phone\n"unfinished'), /unfinished/);
  assert.throws(() => parseRecipientCsv('Phone\n"123"oops'), /invalid quotes/);
  assert.throws(() => parseRecipientCsv(Array(66).fill('x').join(',')), /64 columns/);
  assert.throws(() => parseRecipientCsv(Array(10003).fill('+14165550123').join('\n')), /10,000/);
});
test('mapping removes duplicates, counts blank cells and reports invalid rows without guessing', () => {
  const result = extractPhoneColumn([['Name','Phone'],['A','+1 (416) 555-0123'],['B','004165550124'],['C','+14165550123'],['D',''],['E','4155550123'],['F','=SUM(A1)']], 1, true);
  assert.deepEqual(result.numbers, ['+14165550123','+4165550124']);
  assert.equal(result.duplicates, 1); assert.equal(result.blanks, 1);
  assert.deepEqual(result.invalid.map(item => item.row), [6,7]);
  for (const number of ['+00123', '1.416e10', '4165550123', '+1234567890123456', '123 ext 4']) assert.equal(normalizeImportedNumber(number), '');
});
test('mapping preserves first recipient when the header checkbox is off', () => {
  const rows = [['+14165550123','First'],['+14165550124','Second']];
  assert.deepEqual(extractPhoneColumn(rows,0,false).numbers,['+14165550123','+14165550124']);
  assert.deepEqual(extractPhoneColumn(rows,0,true).numbers,['+14165550124']);
});
test('file reading accepts CSV and rejects unsupported, empty and oversized files', async () => {
  assert.equal((await readRecipientFile(new File(['Phone\n+14165550123'], 'phones.CSV')))[0].rows.length, 2);
  await assert.rejects(readRecipientFile(new File(['data'], 'phones.xls')), /CSV, XLSX/);
  await assert.rejects(readRecipientFile(new File([' '], 'phones.csv')), /empty/);
  await assert.rejects(readRecipientFile({ name:'phones.csv', size: SMS_IMPORT_MAX_BYTES + 1 }), /2 MB/);
  await assert.rejects(readRecipientFile(new File(['bad'], 'phones.xlsx')), /not a readable/);
});
test('Excel import supports multiple sheets, sparse columns, text numbers and rejects formulas as phones', async () => {
  const workbook = new ExcelJS.Workbook();
  const first = workbook.addWorksheet('Customers');
  first.addRow(['Name', '', 'Phone']); first.addRow(['Fictional A', '', '+14165550123']);
  first.getCell('C3').value = { formula: '"+14165550124"', result:'+14165550124' };
  const second = workbook.addWorksheet('Other'); second.addRow(['Mobile']); second.addRow(['+442079460123']);
  const sheets = await readRecipientFile(new File([await workbook.xlsx.writeBuffer()], 'phones.xlsx'));
  assert.deepEqual(sheets.map(sheet => sheet.name), ['Customers','Other']);
  assert.deepEqual(suggestPhoneColumn(sheets[0].rows), {column:2,hasHeader:true});
  const result = extractPhoneColumn(sheets[0].rows,2,true);
  assert.deepEqual(result.numbers, ['+14165550123']); assert.equal(result.invalid.length, 1);
  assert.deepEqual(extractPhoneColumn(sheets[1].rows,0,true).numbers, ['+442079460123']);
});
test('Excel expansion limits are checked before decompression', async () => {
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet('Phones').addRow(['+14165550123']);
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer()), view = new DataView(bytes.buffer);
  for (let i=0;i<bytes.length-46;i++) if (view.getUint32(i,true)===0x02014b50) { view.setUint32(i+24,21*1024*1024,true); break; }
  await assert.rejects(readRecipientFile(new File([bytes], 'phones.xlsx')), /beyond 20 MB/);
});
