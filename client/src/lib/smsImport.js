export const SMS_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 10001, MAX_COLUMNS = 64;

export function parseRecipientCsv(input) {
  let text = input.replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('This file is empty.');
  let delimiter;
  const separator = text.match(/^sep=([,;\t])\r?\n/i);
  if (separator) { delimiter = separator[1]; text = text.slice(separator[0].length); }
  if (!delimiter) {
    const counts = { ',': 0, ';': 0, '\t': 0 }; let quoted = false;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') { if (quoted && text[i + 1] === '"') i++; else quoted = !quoted; }
      else if (!quoted && /[\r\n]/.test(text[i])) break;
      else if (!quoted && text[i] in counts) counts[text[i]]++;
    }
    delimiter = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  }
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  function pushCell() {
    row.push(cell.trim()); cell = ''; closed = false;
    if (row.length > MAX_COLUMNS) throw new Error('Use a file with at most 64 columns.');
  }
  function pushRow() {
    pushCell();
    if (row.some(Boolean)) rows.push(row);
    row = [];
    if (rows.length > MAX_ROWS) throw new Error('Use a file with at most 10,000 data rows.');
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += char;
    } else if (char === delimiter) pushCell();
    else if (char === '\n' || char === '\r') { pushRow(); if (char === '\r' && text[i + 1] === '\n') i++; }
    else if (char === '"' && !cell.trim() && !closed) { quoted = true; cell = ''; }
    else if (char === '"' || (closed && !/\s/.test(char))) throw new Error('The CSV has invalid quotes. Export it again as CSV.');
    else cell += char;
  }
  if (quoted) throw new Error('The CSV has an unfinished quoted value.');
  if (cell || row.length) pushRow();
  if (!rows.length) throw new Error('No rows found in this file.');
  return rows;
}

// Never guess a country code or use a spreadsheet formula as a phone number.
export function normalizeImportedNumber(value) {
  const number = String(value ?? '').trim().replace(/[ ()-]/g, '').replace(/^00/, '+');
  return /^\+[1-9]\d{6,14}$/.test(number) ? number : '';
}

export function suggestPhoneColumn(rows) {
  const header = rows[0] || [];
  const named = header.findIndex(value => /^(phone|mobile|sms|whatsapp|telephone|tel)([\s_-]*(number|no|e164))?$/i.test(String(value).trim()));
  if (named >= 0) return { column: named, hasHeader: true };
  const width = Math.max(1, ...rows.slice(0, 20).map(row => row.length));
  const scores = Array.from({ length: width }, (_, column) => rows.slice(0, 20).filter(row => normalizeImportedNumber(row[column])).length);
  const column = scores.indexOf(Math.max(...scores));
  return { column, hasHeader: Boolean(scores[column] && !normalizeImportedNumber(header[column])) };
}

export function extractPhoneColumn(rows, column, hasHeader) {
  const numbers = [], invalid = []; const seen = new Set(); let duplicates = 0, blanks = 0;
  rows.slice(hasHeader ? 1 : 0).forEach((row, index) => {
    const value = String(row[column] ?? '').trim();
    if (!value) { blanks++; return; }
    const number = normalizeImportedNumber(value);
    if (!number) { invalid.push({ row: index + (hasHeader ? 2 : 1), value }); return; }
    if (seen.has(number)) { duplicates++; return; }
    seen.add(number); numbers.push(number);
  });
  return { numbers, invalid, duplicates, blanks };
}

function checkWorkbookSize(buffer) {
  // Check the ZIP directory before ExcelJS expands the workbook in its worker.
  const data = new DataView(buffer); let end = -1;
  for (let i = data.byteLength - 22; i >= Math.max(0, data.byteLength - 65557); i--) {
    if (data.getUint32(i, true) === 0x06054b50 && i + 22 + data.getUint16(i + 20, true) === data.byteLength) { end = i; break; }
  }
  if (end < 0) throw new Error('This is not a readable XLSX file. Export it again as .xlsx or CSV.');
  const count = data.getUint16(end + 10, true); let offset = data.getUint32(end + 16, true), size = 0;
  if (count > 1000) throw new Error('This workbook is too complex. Export the phone column as CSV.');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || data.getUint32(offset, true) !== 0x02014b50) throw new Error('The XLSX file is damaged.');
    size += data.getUint32(offset + 24, true);
    if (size > 20 * 1024 * 1024) throw new Error('This workbook expands beyond 20 MB. Export the phone column as CSV.');
    offset += 46 + data.getUint16(offset + 28, true) + data.getUint16(offset + 30, true) + data.getUint16(offset + 32, true);
  }
}

export async function readRecipientFile(file) {
  if (file.size > SMS_IMPORT_MAX_BYTES) throw new Error('Choose a file smaller than 2 MB.');
  if (/\.(csv|tsv|txt)$/i.test(file.name)) return [{ name: file.name, rows: parseRecipientCsv(await file.text()) }];
  if (!/\.xlsx$/i.test(file.name)) throw new Error('Choose a CSV, XLSX, TSV, or TXT file.');
  const buffer = await file.arrayBuffer(); checkWorkbookSize(buffer);
  const module = await import('exceljs');
  const workbook = new (module.default || module).Workbook();
  await workbook.xlsx.load(buffer, { ignoreNodes: ['drawing', 'picture', 'conditionalFormatting', 'dataValidations'] });
  const sheets = workbook.worksheets.filter(sheet => sheet.actualRowCount).map(sheet => {
    if (sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLUMNS) throw new Error('Use a sheet with at most 10,000 data rows and 64 columns.');
    const rows = [];
    sheet.eachRow({ includeEmpty: true }, row => {
      const values = [];
      row.eachCell({ includeEmpty: true }, cell => {
        const value = cell.value;
        // Cached formula results can be stale, so require literal phone values.
        values.push(value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value) ? '[formula: paste as values]' : cell.text);
      });
      rows.push(values);
    });
    while (rows.length && !rows[0].some(Boolean)) rows.shift();
    return { name: sheet.name, rows };
  });
  if (!sheets.length) throw new Error('No rows found in this workbook.');
  return sheets;
}
