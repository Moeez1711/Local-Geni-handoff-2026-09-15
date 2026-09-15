import test from 'node:test';
import assert from 'node:assert/strict';
import { categories, curatedCategories } from '../../../server/catalog.js';
import { categoryKey, searchCategories, mergeCategoryRows } from '../../../shared/categorySearch.js';

test('expanded catalogue preserves curated identities and supports Unicode, aliases and industries', () => {
  assert.ok(curatedCategories.length >= 258);
  assert.ok(categories.length > 600);
  assert.equal(new Set(categories.map(row => row.id)).size, categories.length);
  for (const row of curatedCategories) assert.equal(categories.find(item => item.id === row.id).query, row.query);
  assert.ok(searchCategories(categories, 'chemist').some(row => /pharmac/i.test(row.label)));
  assert.ok(searchCategories(categories, 'petrol').some(row => row.query === 'gas station'));
  assert.ok(searchCategories(categories, 'cafe').some(row => /caf/i.test(row.label)));
  assert.ok(searchCategories(categories, 'pakistani').length);
  const food = searchCategories(categories, 'food');
  assert.ok(categories.filter(row => row.group === 'Food & drink').every(row => food.some(match => match.id === row.id)));
  assert.ok(searchCategories(categories, 'dental').some(row => /dentist/i.test(row.label)));
  assert.ok(searchCategories(categories, 'paving').some(row => row.id === 'paving_contractor'));
  assert.ok(searchCategories(categories, 'forestry').some(row => row.id === 'forestry_contractor'));
  assert.ok(searchCategories(categories, 'heavy equipment').some(row => row.id === 'heavy_equipment_dealer'));
  assert.ok(searchCategories(categories, 'quarry').some(row => row.id === 'quarry'));
  assert.ok(categories.filter(row => row.group === 'Contractors & heavy equipment').length >= 40);
  assert.notEqual(categoryKey('مطعم'), categoryKey('صيدلية'));
  assert.equal(categoryKey('Café'), 'cafe');
  assert.deepEqual(searchCategories(categories, '', { favourites: new Set() }), []);
  assert.ok(searchCategories(categories, '', { group: 'Automotive' }).every(row => row.group === 'Automotive'));
});
test('Google IDs deduplicate across locales while keeping translated names searchable', () => {
  const rows = mergeCategoryRows([], [
    { id: 'gbp:gcid:cafe', label: 'Café', query: 'Café', group: 'Google categories' },
    { id: 'gbp:gcid:cafe', label: 'مقهى', query: 'مقهى', group: 'Google categories' },
    { id: 'gbp:gcid:dentist', label: 'Dentist', query: 'Dentist', group: 'Google categories' },
  ]);
  assert.equal(rows.length, 2); assert.equal(searchCategories(rows, 'مقهى')[0].id, 'gbp:gcid:cafe');
  assert.equal(rows.find(row => row.id === 'gbp:gcid:cafe').label, 'Café');
  const merged = mergeCategoryRows(categories, [{ id: 'gbp:gcid:cafe', label: 'Café', query: 'Café', group: 'Google categories' }]);
  assert.equal(merged.filter(row => categoryKey(row.label) === 'cafe').length, 1);
});
