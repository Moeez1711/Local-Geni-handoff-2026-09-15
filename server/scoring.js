import { BOOKABLE_TYPES, WHATSAPP_FIRST } from './catalog.js';
import { isMobileType } from './enrich/contacts.js';

export const TIERS = { hot: 65, potential: 40 };

/**
 * Scores one business row (DB shape, JSON columns already parsed).
 * Returns { score 0-100, tier, reasons[] }; every point is explained.
 */
export function scoreLead(b) {
  const reasons = [];
  let score = 0;
  const add = (points, label) => { score += points; reasons.push({ points, label }); };

  if (b.business_status === 'CLOSED_PERMANENTLY') {
    return { score: 0, tier: 'low', reasons: [{ points: 0, label: 'Permanently closed on Google; skip' }] };
  }

  const site = b.site || {};
  switch (b.site_status) {
    case 'none': add(30, 'No website on Google listing'); break;
    case 'social_only': add(26, 'Only a social/marketplace page as website'); break;
    case 'broken': add(28, `Website broken: ${site.reason || 'unreachable'}`); break;
    case 'ok':
      if (site.design?.verdict === 'outdated') add(20, 'Website looks outdated (markup signals)');
      else if (site.design?.verdict === 'dated') add(10, 'Website looks dated (markup signals)');
      else add(0, 'Website looks reasonably modern; harder sell');
      if (site.mobile?.verdict === 'unlikely') add(8, 'No mobile viewport; likely not mobile-friendly');
      if (site.https === false) add(5, 'No HTTPS');
      if (site.speed === 'slow') add(4, `Slow response (${site.responseMs} ms HTML fetch)`);
      if (site.cta && !site.cta.clear) add(4, 'No clear call/WhatsApp/contact form on homepage');
      if (site.booking && !site.booking.detected && (b.types || []).some((t) => BOOKABLE_TYPES.has(t))) add(3, 'No online booking/ordering detected');
      break;
    case 'unknown': add(0, 'Website could not be analysed; check manually'); break;
    default: add(0, 'Website analysis pending');
  }

  const rating = b.rating ?? 0;
  if (rating >= 4.5) add(12, `Excellent rating ${rating} out of 5`);
  else if (rating >= 4.0) add(8, `Good rating ${rating} out of 5`);
  else if (rating >= 3.5) add(3, `Average rating ${rating} out of 5`);
  else add(0, b.rating == null ? 'No Google rating yet' : `Low rating ${rating} out of 5`);

  const reviews = b.review_count ?? 0;
  if (reviews >= 200) add(14, `${reviews} reviews; busy, established business`);
  else if (reviews >= 50) add(10, `${reviews} reviews; solid customer base`);
  else if (reviews >= 15) add(5, `${reviews} reviews`);
  else add(0, `Only ${reviews} reviews`);

  const priority = WHATSAPP_FIRST.has(b.country_code);
  if (b.whatsapp_source === 'website') add(priority ? 14 : 12, 'WhatsApp link published on website');
  else if (b.phone_e164 && isMobileType(b.phone_type)) add(priority ? 12 : 7, 'Mobile number; likely WhatsApp (unverified)');
  else if (b.phone_e164) add(5, 'Phone number available (landline)');
  else add(-10, 'No phone number on Google');
  if (b.emails?.length) add(3, 'Email address found');

  if (b.business_status === 'OPERATIONAL') add(5, 'Operational');
  else if (b.business_status === 'CLOSED_TEMPORARILY') add(-15, 'Temporarily closed');

  if (b.category_value === 'high') add(8, 'High-value category');
  else if (b.category_value === 'medium') add(4, 'Mid-value category');

  const weakPresence = ['none', 'social_only', 'broken'].includes(b.site_status) || site.design?.verdict === 'outdated';
  if (weakPresence && rating >= 4.2 && reviews >= 30) add(8, 'Strong reputation but weak web presence');

  score = Math.max(0, Math.min(100, score));
  const tier = score >= TIERS.hot ? 'hot' : score >= TIERS.potential ? 'potential' : 'low';
  return { score, tier, reasons };
}
