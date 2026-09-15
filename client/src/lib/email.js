export const EMAIL_PROVIDERS = [
  ['gmail', 'Gmail / Google Workspace'], ['microsoft', 'Microsoft 365 / Outlook'], ['smtp', 'Other provider / SMTP'],
];

export const EMAIL_STATUS_LABELS = {
  sending: 'Sending', sent: 'Accepted by provider', failed: 'Not sent', unknown: 'Outcome unknown',
};

export function isSingleEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value)) return false;
  const local = value.split('@')[0];
  return local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
}

export function emailSignature({ to, subject, text, fromEmail = '', accountId = 'default', inReplyTo = '', references = [] }) {
  return JSON.stringify([accountId || 'default', fromEmail.toLowerCase(), to.toLowerCase(), subject, text, inReplyTo || '', references || []]);
}

export function emailTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function microsoftVerificationUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return ['microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com', 'login.live.com', 'microsoftonline.com'].includes(url.hostname) ? url.href : '';
  } catch { return ''; }
}
