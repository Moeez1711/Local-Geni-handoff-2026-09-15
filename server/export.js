import ExcelJS from 'exceljs';

const reasonsText = (r) => (r.reasons || []).filter((x) => x.points !== 0).map((x) => `${x.label} (${x.points > 0 ? '+' : ''}${x.points})`).join('; ');
const yesNo = (b) => (b == null ? '' : b ? 'yes' : 'no');

const COLUMNS = [
  ['Tier', (r) => ({ hot: 'Hot', potential: 'Potential', low: 'Low' }[r.tier]), 10],
  ['Score', (r) => r.score, 8],
  ['Business', (r) => r.name, 32],
  ['Category', (r) => r.category, 18],
  ['Phone', (r) => r.phone_intl || r.phone_e164 || r.phone_national, 18],
  ['WhatsApp', (r) => r.whatsapp, 16],
  ['WhatsApp source', (r) => (r.whatsapp_source === 'website' ? 'Published on website' : r.whatsapp_source ? 'Mobile number (unverified)' : ''), 22],
  ['Emails', (r) => r.emails.join('; '), 28],
  ['Website', (r) => r.website, 30],
  ['Website status', (r) => r.site_status, 14],
  ['Design (heuristic)', (r) => r.site?.design?.verdict || '', 14],
  ['Mobile (heuristic)', (r) => r.site?.mobile?.verdict || '', 14],
  ['HTTPS', (r) => yesNo(r.site?.https), 8],
  ['Rating', (r) => r.rating, 8],
  ['Reviews', (r) => r.review_count, 9],
  ['Business status', (r) => r.business_status, 18],
  ['Address', (r) => r.address, 40],
  ['Google Maps', (r) => r.maps_url, 30],
  ['Instagram', (r) => r.socials.instagram || '', 26],
  ['Facebook', (r) => r.socials.facebook || '', 26],
  ['Lead status', (r) => r.lead_status, 14],
  ['Notes', (r) => r.notes, 30],
  ['Follow-up', (r) => (r.follow_up_at ? new Date(r.follow_up_at).toLocaleDateString('en-CA') : ''), 12],
  ['Last contacted', (r) => (r.last_contacted_at ? new Date(r.last_contacted_at).toLocaleDateString('en-CA') : ''), 14],
  ['Why this score', reasonsText, 60],
  ['Place ID', (r) => r.place_id, 30],
];

// Neutralise formulas even after whitespace, while preserving plain signed numbers/phones.
const safe = (s) => (/^[\s\uFEFF]*[=+@-]/.test(s) && !/^[+-]\d+(?:\.\d+)?$/.test(s) ? `'${s}` : s);

const columnGroup = index => index <= 3 ? 'Business & priority' : index <= 7 ? 'Contact details' : index <= 12 ? 'Website' : index <= 19 ? 'Business details' : 'Outreach & tracking';
const allColumns = ({ customFields = [], customValues = {} } = {}) => [...COLUMNS.map((row, index) => [...row, `lead:${index}`, columnGroup(index)]),
  ...customFields.filter((field) => !field.archived).map((field) => [
    `Custom: ${field.label} [${field.id}]`,
    (row) => customValues[row.place_id]?.[field.id] ?? '',
    field.type === 'textarea' ? 50 : 28,
    `custom:${field.id}`,
    'Custom fields',
  ]),
];

export const exportColumnMetadata = options => allColumns(options).map(([label, , , id, group]) => ({ id, label, group }));
export function exportColumns(options = {}) {
  const columns = allColumns(options);
  if (options.columns == null) return columns;
  if (!Array.isArray(options.columns) || !options.columns.length || options.columns.length > columns.length || options.columns.some(id => typeof id !== 'string') || new Set(options.columns).size !== options.columns.length) throw Object.assign(new Error('Select at least one valid export column.'), { status: 400 });
  const available = new Map(columns.map(row => [row[3], row]));
  if (options.columns.some(id => !available.has(id))) throw Object.assign(new Error('An export field changed or was archived. Reload the column list.'), { status: 409 });
  return options.columns.map(id => available.get(id));
}
export function exportPreview(rows, options) {
  const columns = exportColumns(options);
  return { columns: columns.map(([label, , , id, group]) => ({ id, label, group })), rows: rows.map(row => columns.map(([, getter]) => getter(row) ?? '')) };
}
export function exportSelection(body = {}) {
  const { ids, filters = {} } = body;
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw Object.assign(new Error('Choose valid export filters.'), { status: 400 });
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 5000 || ids.some(id => typeof id !== 'string' || !id || id.length > 300 || id.includes(',')))) throw Object.assign(new Error('Choose up to 5,000 businesses to export.'), { status: 400 });
  return { empty: Array.isArray(ids) && !ids.length, filters: { ...(ids ? { ids: [...new Set(ids)].join(','), includeClosed: 1, sort: filters.sort, dir: filters.dir } : filters), offset: 0 } };
}

export function toCsv(rows, custom) {
  const columns = exportColumns(custom);
  const cell = (val) => {
    if (val == null) return '';
    const s = safe(String(val));
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(([h]) => cell(h)).join(','), ...rows.map((r) => columns.map(([, fn]) => cell(fn(r))).join(','))];
  return `﻿${lines.join('\r\n')}`;
}

const TIER_FILL = { Hot: 'FFFDE2DD', Potential: 'FFFFF4D6', Low: 'FFF1F3F5' };

export async function toXlsx(rows, custom) {
  const columns = exportColumns(custom);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Local Geni';
  const ws = wb.addWorksheet('Leads', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map(([header, , width, key], index) => ({ header, width, key: key || `lead:${index}` }));
  for (const r of rows) {
    const row = ws.addRow(columns.map(([, fn]) => { const val = fn(r); return typeof val === 'string' ? safe(val) : val ?? ''; }));
    const tierIndex = columns.findIndex(column => column[3] === 'lead:0');
    if (tierIndex >= 0) { const cell = row.getCell(tierIndex + 1); cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TIER_FILL[cell.value] || 'FFFFFFFF' } }; }
  }
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return wb.xlsx.writeBuffer();
}
