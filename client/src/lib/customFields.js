import { isPublicPreviewUrl } from './previews.js';

export const CUSTOM_FIELD_TYPES = [
  ['text', 'Text', 'A name or a short detail'], ['textarea', 'Long text', 'Notes with more room'],
  ['number', 'Number', 'An amount or a count'], ['date', 'Date', 'A date you choose'],
  ['select', 'Dropdown', 'One choice from your options'], ['checkbox', 'Yes or no', 'A true or false value'],
  ['url', 'Website link', 'A public HTTP or HTTPS address'],
];
export const customFieldTypeLabel = type => CUSTOM_FIELD_TYPES.find(([value]) => value === type)?.[1] || type;
export const CUSTOM_FIELD_EXAMPLES = [
  { label: 'Owner name', type: 'text', options: [] }, { label: 'Contract value', type: 'number', options: [] },
  { label: 'Contract renewal date', type: 'date', options: [] }, { label: 'Business segment', type: 'select', options: ['Local service', 'Retail', 'Hospitality', 'Other'] },
];

export function definitionDraft(field) { return { label: field?.label || '', type: field?.type || 'text', optionsText: (field?.options || []).join('\n') }; }
export function definitionPayload(draft) {
  const label = draft.label.trim();
  if (!label || label.length > 100 || /[\x00-\x1f\x7f]/.test(label)) throw new Error('Give this field a name of 1 to 100 characters on one line.');
  if (!CUSTOM_FIELD_TYPES.some(([type]) => type === draft.type)) throw new Error('Choose a supported field type.');
  const options = draft.type === 'select' ? draft.optionsText.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : [];
  if (draft.type === 'select' && (!options.length || options.length > 50)) throw new Error('Add between 1 and 50 dropdown options, one per line.');
  if (options.some(value => value.length > 120 || /[\x00-\x1f\x7f]/.test(value))) throw new Error('Each dropdown option must use up to 120 characters on one line.');
  if (new Set(options.map(value => value.normalize('NFKC').toLocaleLowerCase('en-US'))).size !== options.length) throw new Error('Each dropdown option must be unique.');
  return { label, type: draft.type, options };
}

export function customValuesDraft(definitions = [], values = {}) {
  return Object.fromEntries(definitions.map(field => {
    const value = values[field.id];
    return [field.id, field.type === 'checkbox' ? (typeof value === 'boolean' ? value : null) : value == null ? '' : String(value)];
  }));
}
export function changedCustomFieldIds(definitions = [], draft = {}, saved = {}) {
  return definitions.filter(field => !field.archived && draft[field.id] !== saved[field.id]).map(field => field.id);
}
function parseValue(field, value) {
  if (value === '' || value == null) return null;
  if (field.type === 'checkbox') {
    if (typeof value !== 'boolean') throw new Error('Choose Yes, No, or Not set.');
    return value;
  }
  if (field.type === 'number') {
    if (!String(value).trim()) throw new Error('Enter a number or clear the field.');
    const number = Number(value);
    if (!Number.isFinite(number) || Math.abs(number) > 1e15) throw new Error('Enter a finite number between -1,000,000,000,000,000 and 1,000,000,000,000,000.');
    return number;
  }
  if (typeof value !== 'string') throw new Error('Enter a text value.');
  if (field.type === 'date') {
    const date = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000') || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('Choose a real calendar date.');
  } else if (field.type === 'select') {
    if (!(field.options || []).includes(value)) throw new Error('Choose one of the available options.');
  } else if (field.type === 'url') {
    let url; try { url = new URL(value); } catch { throw new Error('Enter a full public website address, starting with http:// or https://.'); }
    const publicUrl = new URL(url.href); publicUrl.protocol = 'https:';
    if (!['http:', 'https:'].includes(url.protocol) || /[\s\x00-\x1f\x7f]/.test(value) || /%(?:0a|0d)/i.test(value) || !isPublicPreviewUrl(publicUrl.href) || /(?:^|\.)lan\.?$/i.test(url.hostname)) throw new Error('Use a public HTTP or HTTPS link without credentials or a private address.');
  } else if (!['text', 'textarea'].includes(field.type)) throw new Error('This field type is not supported.');
  if (['text', 'textarea'].includes(field.type) && (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || (field.type === 'text' && /[\r\n]/.test(value)))) throw new Error(field.type === 'text' ? 'Enter text on one line.' : 'Remove unsupported control characters.');
  const limit = field.type === 'textarea' ? 5000 : field.type === 'url' ? 2048 : field.type === 'text' ? 500 : null;
  if (limit && value.length > limit) throw new Error(`Use no more than ${limit.toLocaleString()} characters.`);
  return value;
}
export function customValuesPatch(definitions, draft, saved) {
  const values = {}; const errors = {};
  for (const id of changedCustomFieldIds(definitions, draft, saved)) {
    const field = definitions.find(item => item.id === id);
    try { values[id] = parseValue(field, draft[id]); } catch (error) { errors[id] = error.message; }
  }
  return { values, errors };
}
export function customFieldDisplay(value) {
  if (value == null || value === '') return 'Not set';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}
