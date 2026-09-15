import { mergeSettings, messageFor, renderMessage, TEMPLATE_VARS } from './outreach.js';
import { isPublicPreviewUrl } from './previews.js';

export const WHATSAPP_BATCH_LIMIT = 25;

export function batchIds(values) {
  const ids = [...new Set(Array.from(values || []).filter(value => typeof value === 'string' && value))];
  if (!ids.length || ids.length > WHATSAPP_BATCH_LIMIT) throw new Error(`Select between 1 and ${WHATSAPP_BATCH_LIMIT} businesses for a WhatsApp batch.`);
  return ids;
}

export function batchNumber(lead = {}) {
  for (const candidate of [lead.whatsapp, lead.phone_e164]) {
    if (typeof candidate !== 'string' || !/^[+\d ().-]+$/.test(candidate)) continue;
    const digits = candidate.replace(/\D/g, '');
    if (/^[1-9]\d{6,14}$/.test(digits)) return digits;
  }
  return '';
}

export const batchPublishedNumber = lead => Boolean(batchNumber(lead) && lead.whatsapp_source === 'website' && batchNumber(lead) === batchNumber({ whatsapp: lead.whatsapp }));

export function batchContext(preview = {}) {
  return {
    contactName: preview.contactName || '',
    previewUrl: isPublicPreviewUrl(preview.publicUrl) ? preview.publicUrl : '',
    specificImprovement: preview.improvements?.find(value => typeof value === 'string' && value.trim()) || '',
  };
}

export function batchRestriction({ lead = {}, preview = {}, whatsappSuppressed = false } = {}) {
  if (lead.deleted_at != null) return 'This business is in Trash.';
  if (lead.lead_status === 'not_interested') return 'This business is marked not interested.';
  if (preview.stage === 'lost') return 'This opportunity is marked lost.';
  if (whatsappSuppressed) return 'This number has withdrawn WhatsApp permission.';
  return '';
}

export const batchNumberSuppressed = (number, rows = []) => Boolean(number && rows.some(row => row.number === number));

export function batchPreflightError(recipient, detail) {
  if (!detail?.lead || detail.lead.place_id !== recipient.id) return 'This business is no longer available. Close the batch and refresh your leads.';
  const restricted = batchRestriction(detail);
  if (restricted) return restricted;
  if (!batchNumber(detail.lead) || batchNumber(detail.lead) !== recipient.number) return 'The phone number changed. Review the updated recipient before opening a chat.';
  if (detail.lead.name !== recipient.lead.name) return 'The business name changed. Review the message and updated recipient first.';
  if (hasRecordedWhatsAppMessage({ activity: detail.activity }, recipient.message)) return 'This exact WhatsApp message is already recorded as sent. Check the business activity history.';
  return '';
}

export function unsupportedBatchVariables(template) {
  const allowed = new Set(TEMPLATE_VARS);
  return [...new Set(String(template).match(/\{\w+\}/g) || [])].filter(value => !allowed.has(value));
}

export function makeBatchRecipients(entries, template, settings, recommended = false) {
  const configured = mergeSettings(settings);
  const numbers = new Map();
  return entries.map(entry => {
    const lead = entry.lead || {}; const preview = entry.preview || {};
    const number = batchNumber(lead); const duplicateOf = number ? numbers.get(number) : null;
    if (number && !duplicateOf) numbers.set(number, lead.name || entry.id);
    const context = batchContext(preview); const restriction = batchRestriction(entry);
    const message = entry.error ? '' : recommended ? messageFor(lead, configured, context) : renderMessage(template, lead, configured, context);
    return { ...entry, number, duplicateOf, context, message,
      restriction, included: !entry.error && Boolean(number) && !duplicateOf && !restriction,
      reviewed: false, openedMessage: null, sentMessage: null,
      publishedNumber: batchPublishedNumber(lead),
      missingDesignLink: !recommended && template.includes('{previewUrl}') && !context.previewUrl,
    };
  });
}

export const batchSnapshotKey = (id, number, message) => JSON.stringify([id, number, message]);
export const hasRecordedWhatsAppMessage = (recipient, message = recipient.message) => (recipient.activity || []).some(item => item.kind === 'sent' && item.channel === 'whatsapp' && item.message === message);
