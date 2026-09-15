// Shared by the picker and server catalogue. IDs and provider type codes remain separate.
export const categoryKey = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export const CATEGORY_SYNONYMS = [
  ['cafe', 'cafes', 'coffee shop', 'coffeehouse', 'coffee house'],
  ['pharmacy', 'pharmacies', 'chemist', 'drugstore'],
  ['car repair', 'auto repair', 'mechanic', 'garage'],
  ['gas station', 'petrol station', 'fuel station'],
  ['beauty salon', 'beauty parlour', 'beauty parlor', 'salon'],
  ['hair salon', 'hairdresser', 'hair stylist'],
  ['real estate agency', 'estate agent', 'property agent', 'realtor'],
  ['grocery store', 'grocer', 'kirana', 'baqala', 'convenience store'],
  ['dentist', 'dentists', 'dental clinic', 'dental care'],
  ['physiotherapist', 'physiotherapy', 'physical therapist'],
  ['lawyer', 'lawyers', 'solicitor', 'attorney'],
  ['accounting', 'accountant', 'accountants', 'bookkeeper'],
  ['child care', 'childcare', 'daycare', 'nursery'],
  ['gym', 'gyms', 'fitness center', 'fitness centre'],
  ['cell phone store', 'mobile phone shop', 'phone shop'],
  ['takeaway', 'takeout', 'meal takeaway'],
  ['hookah bar', 'shisha lounge', 'shisha'],
  ['veterinary care', 'veterinary clinic', 'vet', 'vets'],
  ['non profit organization', 'charity', 'ngo'],
  ['cctv', 'security camera', 'surveillance'],
];

export function categoryAliases(row) {
  const terms = [row.label, row.query, ...(row.aliases || [])].map(categoryKey);
  const matched = CATEGORY_SYNONYMS.filter(group => group.some(term => terms.some(value => value === term || value.startsWith(`${term} `))));
  return [...new Set([...(row.aliases || []), ...matched.flat()])];
}

export function searchCategories(rows, query, { group = '', favourites = null } = {}) {
  const needle = categoryKey(query);
  const tokens = needle.split(' ').filter(Boolean);
  return rows.filter(row => (!group || row.group === group) && (!favourites || favourites.has(row.id)))
    .map(row => {
      const name = categoryKey(row.label), text = categoryKey([row.label, row.query, row.group, ...(row.aliases || [])].join(' '));
      const matches = tokens.every(token => text.includes(token));
      return { row, score: !needle ? 0 : name === needle ? 3 : name.startsWith(needle) ? 2 : matches ? 1 : -1 };
    }).filter(item => item.score >= 0).sort((a, b) => b.score - a.score || a.row.label.localeCompare(b.row.label)).map(item => item.row);
}

export function mergeCategoryRows(bundled, googleRows) {
  const byId = new Map();
  for (const row of googleRows) {
    const previous = byId.get(row.id);
    if (previous) previous.aliases = [...new Set([...previous.aliases, row.label, ...(row.aliases || [])])];
    else byId.set(row.id, { ...row, aliases: categoryAliases(row) });
  }
  // Prefer a provider identity for exact labels/queries, retaining curated aliases and scoring.
  const byName = new Map([...byId.values()].map(row => [categoryKey(row.label), row]));
  for (const row of bundled) {
    const existing = byName.get(categoryKey(row.label)) || byName.get(categoryKey(row.query));
    if (existing) {
      existing.aliases = [...new Set([...existing.aliases, row.label, ...categoryAliases(row)])];
      existing.group = row.group; existing.value = row.value;
    } else byId.set(row.id, { ...row, aliases: categoryAliases(row) });
  }
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
}
