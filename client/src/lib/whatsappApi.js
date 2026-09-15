import { batchContext, batchNumber, batchRestriction } from './whatsappBatch.js';

export const WA_API_STATUSES = { queued: 'Queued', pending: 'Queued', sending: 'Sending', accepted: 'Accepted by Meta', sent: 'Accepted by Meta', failed: 'Not sent', unknown: 'Outcome uncertain', cancelled: 'Canceled', canceled: 'Canceled', paused: 'Paused', completed: 'Finished', running: 'Running', active: 'Running' };
export const WA_PARAMETER_SOURCES = [['name', 'Business name'], ['contactName', 'Contact name'], ['category', 'Business category'], ['previewUrl', 'Approved website link'], ['specificImprovement', 'Pitch note'], ['signoff', 'Your name and company'], ['custom', 'Custom text']];

export function resolveWhatsAppParameter(binding = {}, entry, settings = {}) {
  const context = batchContext(entry.preview);
  const values = { name: entry.lead?.name || '', category: entry.lead?.category || '', contactName: context.contactName, previewUrl: context.previewUrl, specificImprovement: context.specificImprovement, signoff: [settings.myName, settings.myCompany].filter(Boolean).join(', ') };
  return binding.source === 'custom' ? String(binding.value || '') : values[binding.source] || '';
}

export function whatsappApiRecipients(entries, template, bindings, settings, included) {
  const seen = new Set();
  return entries.filter(entry => included[entry.id]).map(entry => {
    if (entry.error || !entry.lead) throw new Error('A selected business could not be loaded.');
    const restricted = batchRestriction(entry); if (restricted) throw new Error(`${entry.lead.name}: ${restricted}`);
    const number = batchNumber(entry.lead); if (!number) throw new Error(`${entry.lead.name} needs a usable international phone number.`);
    if (seen.has(number)) throw new Error('Two selected businesses share one WhatsApp number. Include only one.');
    seen.add(number);
    const parameters = {};
    for (const parameter of template.parameters || []) {
      let value = resolveWhatsAppParameter(bindings[parameter.key], entry, settings);
      if (parameter.key.startsWith('button.') && bindings[parameter.key]?.source === 'previewUrl' && value) {
        const button = (template.buttons || []).find(button => String(button.index) === parameter.key.split('.')[1]);
        const parts = button?.url?.split('{{1}}');
        if (!parts || parts.length !== 2 || !value.startsWith(parts[0]) || (parts[1] && !value.endsWith(parts[1]))) throw new Error(`${entry.lead.name}: the URL does not match this template button's approved URL. Use a text field or the approved URL.`);
        value = value.slice(parts[0].length, parts[1] ? -parts[1].length : undefined);
      }
      if (!value.trim()) throw new Error(`${entry.lead.name}: fill ${parameter.label || parameter.key} before reviewing.`);
      if (value.length > 1024 || /[\r\n\t]/.test(value) || / {5}/.test(value) || /\{\{|\}\}/.test(value)) throw new Error(`${entry.lead.name}: ${parameter.label || parameter.key} must be final, single-line text of up to 1,024 characters, without unresolved template fields or long spaces.`);
      parameters[parameter.key] = value;
    }
    return { placeId: entry.id, number, parameters };
  });
}

export function matchingWhatsAppConsent(entry, rows = []) {
  const number = batchNumber(entry.lead);
  return rows.find(row => row.placeId === entry.id && String(row.number || '').replace(/\D/g, '') === number && row.optedIn === true) || null;
}

export const whatsappReviewKey = (message, index) => JSON.stringify([index, message.placeId, message.number, message.header, message.body, message.footer, message.buttons, message.text]);
export const whatsappHasUnresolved = batch => (batch?.rows || []).some(row => ['queued', 'pending', 'sending', 'unknown'].includes(row.status));
export const whatsappHasQueued = batch => (batch?.rows || []).some(row => ['queued', 'pending'].includes(row.status));
export const whatsappTime = value => { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); };
