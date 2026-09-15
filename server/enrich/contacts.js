import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/** Normalises a phone and classifies it (MOBILE / FIXED_LINE / ...) from numbering-plan metadata. */
export function classifyPhone(intl, national, countryCode) {
  const p = (intl && parsePhoneNumberFromString(intl)) || (national && parsePhoneNumberFromString(national, countryCode));
  if (!p || !p.isValid()) return { e164: null, type: null };
  return { e164: p.number, type: p.getType() || null };
}

export const isMobileType = (t) => t === 'MOBILE' || t === 'FIXED_LINE_OR_MOBILE';

const WA_PATTERNS = [
  /wa\.me\/\+?(\d{7,15})/i,
  /(?:api|web)\.whatsapp\.com\/send\/?\?(?:[^"'\s]*&)?phone=\+?(\d{7,15})/i,
  /whatsapp:\/\/send\/?\?(?:[^"'\s]*&)?phone=\+?(\d{7,15})/i,
];

export function findWhatsApp(hrefs) {
  for (const h of hrefs) for (const re of WA_PATTERNS) {
    const m = h.match(re);
    if (m) return `+${m[1]}`;
  }
  return null;
}

const SOCIAL = {
  instagram: /instagram\.com\/(?!p\/|reel\/|explore\/)[\w.]+/i,
  facebook: /(?:facebook|fb)\.com\/(?!sharer|share|plugins|dialog|tr\?)[\w.\-/?=]+/i,
  tiktok: /tiktok\.com\/@[\w.]+/i,
  x: /(?:twitter|x)\.com\/(?!intent|share)\w+/i,
  linkedin: /linkedin\.com\/(?:company|in)\/[\w\-]+/i,
  youtube: /youtube\.com\/(?:@|channel\/|c\/)[\w\-]+/i,
  snapchat: /snapchat\.com\/add\/[\w.\-]+/i,
};

export function findSocials(hrefs) {
  const out = {};
  for (const h of hrefs) for (const [k, re] of Object.entries(SOCIAL)) {
    if (!out[k] && re.test(h)) out[k] = h.split('#')[0];
  }
  return out;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const EMAIL_JUNK = /\.(png|jpe?g|gif|svg|webp|css|js)$|example\.|sentry|wixpress|@2x|domain\.com|email\.com|yourmail|u003e/i;

export function findEmails(hrefs, text) {
  const found = new Set();
  for (const h of hrefs) if (h.toLowerCase().startsWith('mailto:')) {
    const e = decodeURIComponent(h.slice(7).split('?')[0]).trim().toLowerCase();
    if (e.includes('@')) found.add(e);
  }
  for (const m of (text || '').match(EMAIL_RE) || []) found.add(m.toLowerCase());
  return [...found].filter((e) => !EMAIL_JUNK.test(e)).slice(0, 5);
}
