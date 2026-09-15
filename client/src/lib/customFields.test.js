import test from 'node:test';
import assert from 'node:assert/strict';
import { changedCustomFieldIds, customFieldDisplay, customValuesDraft, customValuesPatch, definitionDraft, definitionPayload } from './customFields.js';

const fields = [
  { id: 'name', label: 'Owner', type: 'text' }, { id: 'amount', label: 'Contract value', type: 'number' },
  { id: 'approved', label: 'Approved', type: 'checkbox' }, { id: 'date', label: 'Date', type: 'date' },
  { id: 'segment', label: 'Segment', type: 'select', options: ['New', 'Existing'] },
  { id: 'url', label: 'Website', type: 'url' }, { id: 'old', label: 'Old detail', type: 'text', archived: true },
];

test('field definitions preserve names, validate options, and avoid silently selecting a data type', () => {
  assert.deepEqual(definitionPayload({ label: '  Owner José  ', type: 'text', optionsText: '' }), { label: 'Owner José', type: 'text', options: [] });
  assert.deepEqual(definitionPayload({ label: 'Segment', type: 'select', optionsText: 'New\nExisting\n' }).options, ['New', 'Existing']);
  assert.throws(() => definitionPayload({ label: '', type: 'text', optionsText: '' }), /name/);
  assert.throws(() => definitionPayload({ label: 'Name', type: 'unsupported', optionsText: '' }), /supported field type/);
  assert.throws(() => definitionPayload({ label: 'Segment', type: 'select', optionsText: 'New\nNew' }), /unique/);
  assert.throws(() => definitionPayload({ label: 'Segment', type: 'select', optionsText: '' }), /1 and 50/);
  assert.equal(definitionDraft({ label: 'Segment', type: 'select', options: ['New', 'Existing'] }).optionsText, 'New\nExisting');
});

test('drafts distinguish zero, false and unset values', () => {
  const draft = customValuesDraft(fields, { amount: 0, approved: false, name: 'José' });
  assert.equal(draft.amount, '0'); assert.equal(draft.approved, false); assert.equal(draft.name, 'José');
  assert.equal(customValuesDraft(fields, {}).approved, null);
  assert.equal(customFieldDisplay(0), '0'); assert.equal(customFieldDisplay(false), 'No'); assert.equal(customFieldDisplay(null), 'Not set');
});

test('saving sends only edited active fields, retaining exact text and typed zero or false', () => {
  const saved = customValuesDraft(fields, { old: 'Keep archived data' });
  const draft = { ...saved, name: ' José García ', amount: '0', approved: false, old: 'A stale edit' };
  assert.deepEqual(changedCustomFieldIds(fields, draft, saved), ['name', 'amount', 'approved']);
  assert.deepEqual(customValuesPatch(fields, draft, saved), { values: { name: ' José García ', amount: 0, approved: false }, errors: {} });
  assert.equal(saved.old, 'Keep archived data');
});

test('clearing is explicit and omitted fields are never removed from the saved record', () => {
  const saved = customValuesDraft(fields, { name: 'José', amount: 0, approved: false });
  const patch = customValuesPatch(fields, { ...saved, amount: '', approved: null }, saved);
  assert.deepEqual(patch, { values: { amount: null, approved: null }, errors: {} });
  assert.equal('name' in patch.values, false);
});

test('typed validation rejects impossible dates, nonfinite numbers and unavailable options per field', () => {
  const saved = customValuesDraft(fields, {});
  const result = customValuesPatch(fields, { ...saved, date: '2026-02-30', amount: 'Infinity', segment: 'Removed', approved: 'false', url: 'javascript:alert(1)' }, saved);
  assert.deepEqual(Object.keys(result.errors).sort(), ['amount', 'approved', 'date', 'segment', 'url']);
  assert.deepEqual(result.values, {});
  const valid = customValuesPatch(fields, { ...saved, date: '2028-02-29', amount: '-12.5', segment: 'Existing', url: 'https://business.agency/page?a=1&b=2' }, saved);
  assert.deepEqual(valid.errors, {}); assert.equal(valid.values.amount, -12.5); assert.equal(valid.values.date, '2028-02-29');
});

test('unchanged legacy values do not block another field edit', () => {
  const saved = customValuesDraft(fields, { segment: 'Legacy segment', amount: 0, approved: false });
  const result = customValuesPatch(fields, { ...saved, name: 'Updated owner' }, saved);
  assert.deepEqual(result, { values: { name: 'Updated owner' }, errors: {} });
  assert.deepEqual(customValuesPatch(fields, saved, saved), { values: {}, errors: {} });
});
