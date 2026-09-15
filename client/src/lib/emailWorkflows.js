import { isSingleEmail } from './email.js';

export const CAMPAIGN_STATUS_LABELS = {
  draft: 'Draft', running: 'Running', active: 'Running', paused: 'Paused', completed: 'Finished',
  cancelled: 'Canceled', canceled: 'Canceled', failed: 'Needs attention',
};
export const INBOX_KIND_LABELS = { reply: 'Reply', bounce: 'Bounce', opt_out: 'Opted out', ignore: 'Ignored', unmatched: 'Not linked to a business', automated: 'Automatic response', unknown: 'Needs review' };

export function groupInboxThreads(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const correspondent = (row.fromEmail || '').toLowerCase();
    const key = JSON.stringify([String(row.accountId || ''), row.placeId || correspondent || row.id]);
    if (!groups.has(key)) groups.set(key, { id: key, accountId: row.accountId, placeId: row.placeId, messages: [] });
    groups.get(key).messages.push(row);
  }
  return [...groups.values()].map((thread) => {
    thread.messages.sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime());
    return { ...thread, latest: thread.messages[thread.messages.length - 1] };
  }).sort((a, b) => new Date(b.latest.receivedAt).getTime() - new Date(a.latest.receivedAt).getTime());
}

export function validateCampaign(draft) {
  if (!draft.name?.trim()) return 'Give this sequence a name.';
  if (!draft.accountId) return 'Choose a sender mailbox.';
  if (!draft.recipients?.length || draft.recipients.length > 25) return 'Choose between 1 and 25 businesses.';
  const seen = new Set();
  for (const recipient of draft.recipients) {
    if (!recipient.placeId || !isSingleEmail(recipient.to?.trim())) return 'Choose one complete email address for every business.';
    const email = recipient.to.trim().toLowerCase();
    if (seen.has(email)) return 'Two businesses use the same email address. Keep just one of them in this sequence.';
    seen.add(email);
  }
  try { new Intl.DateTimeFormat('en', { timeZone: draft.timezone }); } catch { return 'Enter a valid time zone, such as America/Toronto.'; }
  const window = draft.sendWindow;
  if (!window?.days?.length || window.days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) return 'Choose at least one sending day.';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(window.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(window.end) || window.start >= window.end) return 'The sending window must end later on the same day.';
  if (!draft.steps?.length || draft.steps.length > 5) return 'Add between 1 and 5 emails.';
  for (let i = 0; i < draft.steps.length; i++) {
    const step = draft.steps[i];
    if (!step.subject?.trim() || step.subject.length > 200 || /[\r\n]/.test(step.subject)) return `Email ${i + 1} needs a subject on one line, up to 200 characters.`;
    if (!step.text?.trim() || step.text.length > 9000) return `Email ${i + 1} needs a message up to 9,000 characters before personalization and opt-out text.`;
    if (!Number.isFinite(Number(step.delayHours)) || (i > 0 && Number(step.delayHours) < 1) || Number(step.delayHours) > 2160) return `Choose a wait of 1 to 2,160 hours before email ${i + 1}.`;
  }
  return '';
}

// Include all reviewed content in UI checkbox identity. A refreshed review clears approval.
export function campaignReviewKey(message, index) {
  return JSON.stringify([index, message.placeId, message.to, message.stepIndex, message.fromEmail, message.subject, message.text, message.scheduledAfterHours]);
}

export function campaignPayload(draft) {
  return {
    name: draft.name.trim(), accountId: draft.accountId, timezone: draft.timezone,
    sendWindow: { start: draft.sendWindow.start, end: draft.sendWindow.end, days: [...draft.sendWindow.days] },
    recipients: draft.recipients.map(({ placeId, to }) => ({ placeId, to: to.trim() })),
    steps: draft.steps.map((step, index) => ({ subject: step.subject, text: step.text, delayHours: index ? Number(step.delayHours) : 0 })),
  };
}
