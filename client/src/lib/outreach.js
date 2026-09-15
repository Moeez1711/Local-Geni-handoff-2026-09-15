import { fmt } from './api.js';

export const ANGLES = [
  ['no_website', 'No website'], ['social_only', 'Social page only'], ['broken', 'Broken site'],
  ['outdated', 'Outdated site'], ['general', 'General'],
];

export const TEMPLATE_VARS = ['{name}', '{contactName}', '{category}', '{rating}', '{reviews}', '{website}', '{platform}', '{compliment}', '{previewUrl}', '{specificImprovement}', '{signoff}'];

const t = (...lines) => lines.join('\n');
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Normalize template decoration before inserting names or other business data. */
export function cleanOutreachTemplate(template) {
  if (typeof template !== 'string') return '';
  return Array.from(graphemes.segment(template), ({ segment }) => {
    const emoji = /\p{Emoji_Presentation}|[#*0-9]\uFE0F?\u20E3/u.test(segment)
      || (/\p{Extended_Pictographic}/u.test(segment) && !/^[©®™]$/.test(segment));
    return emoji ? '' : segment;
  }).join('')
    .replace(/\{rating\}\s*[★☆]/g, '{rating} out of 5')
    .replace(/(\d(?:\.\d+)?)\s*[★☆]/g, '$1-star')
    .replace(/^[ \t]*[•●▪◦◆◇★☆✓✔✦✧]+[ \t]*/gm, '- ')
    .replace(/[★☆]/g, '')
    .replace(/^[ \t]*[—–][ \t]*/gm, '')
    .replace(/[ \t]*—[ \t]*/g, ', ')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

export const DEFAULT_SETTINGS = {
  myName: '',
  myCompany: '',
  autoMarkContacted: false,
  templates: {
    no_website: t(
      'Hi {name} team,', '',
      "I found {name} on Google Maps. {compliment}I noticed you don't have a website yet, so a dedicated site could give customers one place to find your services, contact details and opening hours.", '',
      'I build fast, mobile-friendly websites for local businesses. Could I send you a free sample homepage for {name}?', '',
      '{signoff}',
    ),
    social_only: t(
      'Hi {name} team,', '',
      'I found {name} on Google Maps. {compliment}Your listing links to your {platform} page instead of a website. That works for followers, but new customers searching Google usually want a website with your services, contact details and opening hours.', '',
      'I build fast, mobile-friendly websites for local businesses. Could I send you a free sample homepage for {name}?', '',
      '{signoff}',
    ),
    broken: t(
      'Hi {name} team,', '',
      "I tried to visit {website} from your Google Maps listing, but it isn't loading at the moment, so customers who click it may think you're closed.", '',
      'I can fix or rebuild it quickly so it is fast and works well on phones. Would that be helpful?', '',
      '{signoff}',
    ),
    outdated: t(
      'Hi {name} team,', '',
      'I came across {website} while looking for a {category} nearby. {compliment}The site could use a refresh, especially on mobile, where most customers search today.', '',
      'I build modern, fast websites with WhatsApp and booking buttons. Could I send you a free redesign idea for {name}?', '',
      '{signoff}',
    ),
    general: t(
      'Hi {name} team,', '',
      'I found {name} on Google Maps. {compliment}I help local businesses turn Google searches into WhatsApp enquiries and bookings with a fast, modern website.', '',
      'Would you be open to a quick chat?', '',
      '{signoff}',
    ),
  },
};

export const mergeSettings = (s = {}) => ({
  ...DEFAULT_SETTINGS, ...s, autoMarkContacted: false,
  templates: Object.fromEntries(Object.entries({ ...DEFAULT_SETTINGS.templates, ...(s.templates || {}) })
    .map(([key, template]) => [key, cleanOutreachTemplate(template)])),
});

/** Chooses the pitch from the lead's actual web presence. */
export function pickAngle(lead) {
  if (lead.site_status === 'none') return 'no_website';
  if (lead.site_status === 'social_only') return 'social_only';
  if (lead.site_status === 'broken') return 'broken';
  const site = lead.site;
  if (lead.site_status === 'ok' && (site?.design?.verdict !== 'modern' || site?.mobile?.verdict === 'unlikely')) return 'outdated';
  return 'general';
}

const PLATFORMS = { 'instagram.com': 'Instagram', 'facebook.com': 'Facebook', 'fb.com': 'Facebook', 'tiktok.com': 'TikTok',
  'linktr.ee': 'Linktree', 'talabat.com': 'Talabat', 'snapchat.com': 'Snapchat', 'x.com': 'X', 'twitter.com': 'X' };

function platformOf(lead) {
  try {
    const host = new URL(lead.site?.finalUrl || lead.website).hostname.replace(/^www\./, '');
    return Object.entries(PLATFORMS).find(([d]) => host === d || host.endsWith(`.${d}`))?.[1] || 'social media';
  } catch { return 'social media'; }
}

export function renderMessage(template, lead, settings, context = {}) {
  const reviews = lead.review_count || 0;
  const compliment = lead.rating >= 4.3 && reviews >= 20
    ? `Your rating of ${lead.rating} out of 5 from ${fmt.num(reviews)} reviews really stands out. `
    : reviews >= 10 ? 'Your customers clearly like you. ' : '';
  const vars = {
    name: lead.name,
    category: (lead.category || 'business').toLowerCase(),
    rating: lead.rating ?? '',
    reviews: fmt.num(reviews),
    website: (lead.website || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''),
    platform: platformOf(lead),
    compliment,
    contactName: context.contactName || `${lead.name} team`,
    previewUrl: context.previewUrl || '',
    specificImprovement: context.specificImprovement || '',
    signoff: [settings.myName, settings.myCompany].filter(Boolean).join(', '),
  };
  return cleanOutreachTemplate(template)
    .replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
    .replace(/\n{3,}/g, '\n\n').trim();
}

export const messageFor = (lead, settings, context) => renderMessage(settings.templates[pickAngle(lead)], lead, settings, context);
export const waLink = (e164, text) => `https://wa.me/${fmt.digits(e164)}${text ? `?text=${encodeURIComponent(text)}` : ''}`;

export const toDateInput = (ts) => (ts ? new Date(ts).toLocaleDateString('en-CA') : '');
export const fromDateInput = (s) => {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 9).getTime();
};
export const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(9, 0, 0, 0); return d.getTime(); };
export const isDue = (ts) => Boolean(ts) && ts <= new Date().setHours(23, 59, 59, 999);
export const shortDate = (ts) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
