export const PREVIEW_STAGES = [
  ['shortlisted', 'Shortlisted'], ['designing', 'Designing'], ['ready', 'Ready to share'],
  ['shared', 'Sent'], ['replied', 'Replied'], ['call_booked', 'Call booked'], ['won', 'Won'], ['lost', 'Lost'],
];

/** A prospect needs a public HTTPS address, never this computer's review URL. */
export function isPublicPreviewUrl(value) {
  if (!value?.trim()) return false;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return url.protocol === 'https:' && !url.username && !url.password
      && !url.port && !/[:\[\]]/.test(host)
      && /\.[a-z]{2,}$/.test(host)
      && !/(^|\.)(localhost|local|internal|test|invalid|example)$/.test(host)
      && !/(^|\.)(example\.(com|org|net)|localtest\.me|lvh\.me)$/.test(host);
  } catch { return false; }
}

export function previewMessage(lead, preview, settings = {}) {
  if (!isPublicPreviewUrl(preview?.publicUrl)) return '';
  const name = lead?.name || 'your business';
  const greeting = preview.contactName?.trim() || `${name} team`;
  const improvements = (preview.improvements || []).filter((v) => v?.trim()).slice(0, 3);
  const signoff = [settings.myName, settings.myCompany || settings.company].filter((v) => v?.trim()).join(', ');
  return [
    `Hi ${greeting},`,
    `I put together a homepage concept for ${name}.`,
    improvements.length ? `The design focuses on:\n${improvements.map((v, index) => `${index + 1}. ${v.trim()}`).join('\n')}` : '',
    `You can see it here:\n${preview.publicUrl.trim()}`,
    "If you like the direction, I'd be happy to talk through building the full site.",
    signoff,
  ].filter(Boolean).join('\n\n');
}
