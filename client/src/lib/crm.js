export const CRM_STAGES = [
  ['new', 'New opportunity'], ['contacted', 'Conversation started'], ['qualified', 'Qualified'], ['design_shared', 'Design shared'],
  ['meeting', 'Meeting booked'], ['proposal', 'Proposal sent'], ['won', 'Won'], ['lost', 'Lost'],
];
export const CRM_CURRENCIES = ['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'NZD', 'PKR', 'AED', 'SAR', 'INR'];
export function crmDraft(kind, row = {}) {
  if (kind === 'company') return { name: row.name || '', website: row.website || '', email: row.email || row.emails?.[0] || '', phone: row.phone || row.phone_e164 || '' };
  if (kind === 'contact') return { companyId: row.companyId || '', name: row.name || '', email: row.email || '', phone: row.phone || '', jobTitle: row.jobTitle || '', notes: row.notes || '' };
  return { companyId: row.companyId || '', contactId: row.contactId || '', title: row.title || '', stage: row.stage || 'new', value: row.value == null ? '' : String(row.value), currency: row.currency || 'USD', ownerId: row.ownerId || '', followUpDate: row.followUpDate || '', notes: row.notes || '' };
}
export function crmPayload(kind, draft) {
  const values = { ...draft };
  if (kind !== 'company' && !values.companyId) throw new Error('Choose a company first.');
  if (!(kind === 'deal' ? values.title : values.name)?.trim()) throw new Error(kind === 'deal' ? 'Enter a deal name.' : `Enter a ${kind} name.`);
  if (kind === 'deal') {
    values.value = draft.value === '' ? null : Number(draft.value);
    if (values.value != null && (!Number.isFinite(values.value) || values.value < 0 || values.value > 1e12 || Math.abs(values.value * 100 - Math.round(values.value * 100)) > .0001)) throw new Error('Enter a deal value from zero to 1,000,000,000,000 with up to two decimal places.');
    if (!CRM_STAGES.some(([id]) => id === values.stage)) throw new Error('Choose a deal stage.');
    if (!CRM_CURRENCIES.includes(values.currency)) throw new Error('Choose a supported currency.');
    values.contactId = draft.contactId || null; values.ownerId = draft.ownerId || null; values.followUpDate = draft.followUpDate || null;
    if (values.followUpDate) { const date = new Date(`${values.followUpDate}T00:00:00Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(values.followUpDate) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== values.followUpDate) throw new Error('Choose a real follow-up date.'); }
  }
  return values;
}
export function crmMoney(value, currency = 'USD') { return value == null || value === '' ? 'Value not set' : new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value); }
export function crmDue(date, today = new Date()) {
  if (!date) return false;
  const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return date <= local;
}
export function crmContactEmailLead(lead, contact) {
  if (!lead?.place_id || lead.place_id !== contact?.placeId || !contact.email) throw new Error('Reload this contact and its company before composing an email.');
  return { ...lead, emails: [contact.email] };
}
