/**
 * Lightweight website analysis from a server-side HTML fetch.
 * Everything here is a heuristic derived from HTTP + markup. It does NOT render the page,
 * so real mobile layout, visual quality and Core Web Vitals are reported as unavailable.
 */
import * as cheerio from 'cheerio';
import { findEmails, findSocials, findWhatsApp } from './contacts.js';
import { domainOf } from '../util.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const MAX_BYTES = 2_000_000;

export const NOT_MEASURED = [
  'Real mobile rendering (no headless browser) — mobile verdict is from viewport/CSS markup only',
  'Visual design quality — design verdict is from markup signals only',
  'Core Web Vitals / Lighthouse — speed is server-side HTML fetch time only',
];

const SOCIAL_ONLY = /(^|\.)(facebook\.com|fb\.com|instagram\.com|linktr\.ee|wa\.me|whatsapp\.com|tiktok\.com|twitter\.com|x\.com|snapchat\.com|youtube\.com|t\.me|linkedin\.com|talabat\.com|deliveroo\.[a-z.]+|ubereats\.com|zomato\.com|booking\.com|tripadvisor\.[a-z.]+)$/i;
const DEAD_BUILDERS = /(^|\.)business\.site$/i; // Google Business Profile sites were shut down in 2024
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$)/i;
const BOOKING = /calendly|fresha|booksy|setmore|simplybook|acuityscheduling|opentable|resy\.com|sevenrooms|talabat|deliveroo|ubereats|zomato|book\s?now|book an appointment|make a reservation|reserve a table|order online|order now|add-to-cart|add to cart|حجز|اطلب الآن/i;

const NET_REASONS = {
  ENOTFOUND: 'domain does not resolve (DNS)', EAI_AGAIN: 'DNS lookup failed', ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset', UND_ERR_CONNECT_TIMEOUT: 'connection timed out', TimeoutError: 'no response within 12 s',
  CERT_HAS_EXPIRED: 'SSL certificate expired', ERR_TLS_CERT_ALTNAME_INVALID: 'SSL certificate does not match the domain',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed SSL certificate', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'invalid SSL certificate chain',
};
const netReason = (e) => `Unreachable — ${NET_REASONS[e.cause?.code] || NET_REASONS[e.name] || e.cause?.code || e.message}`;

async function fetchHtml(url, timeoutMs) {
  const started = Date.now();
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en,ar;q=0.8' },
  });
  const ttfbMs = Date.now() - started;
  let html = '';
  if ((res.headers.get('content-type') || '').includes('html')) {
    const reader = res.body.getReader();
    const chunks = []; let size = 0;
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.length;
    }
    reader.cancel().catch(() => {});
    html = Buffer.concat(chunks).toString('utf8');
  } else {
    res.body?.cancel().catch(() => {});
  }
  return { res, html, ttfbMs, totalMs: Date.now() - started };
}

function designSignals($, html, https) {
  const signals = [];
  let points = 0;
  const flag = (p, label) => { points += p; signals.push({ label, weight: p }); };
  const year = new Date().getFullYear();

  if (!$('meta[name="viewport"]').length) flag(2, 'No responsive viewport meta tag');
  if ($('font, center, marquee, blink, frameset').length) flag(2, 'Deprecated HTML tags (font/center/marquee/frameset)');
  if (/\.swf\b|shockwave-flash/i.test(html)) flag(3, 'Flash content');
  if ($('table').length >= 3 && !$('nav, header, section, main, footer').length) flag(1, 'Table-based layout, no semantic HTML5');
  const jq = html.match(/jquery[.-]?(\d)\.(\d+)/i);
  if (jq && (Number(jq[1]) < 2 && Number(jq[2]) < 12)) flag(1, `Old jQuery ${jq[1]}.${jq[2]}`);
  const copy = [...html.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(20\d{2}|19\d{2})/gi)].map((m) => Number(m[1]));
  if (copy.length && Math.max(...copy) <= year - 3) flag(1, `Copyright year ${Math.max(...copy)}`);
  const gen = $('meta[name="generator"]').attr('content') || '';
  const wp = gen.match(/WordPress\s+(\d+)/i);
  if (wp && Number(wp[1]) < 5) flag(1, `Old ${gen}`);
  if (/joomla!?\s*1\.|frontpage|dreamweaver/i.test(gen)) flag(2, `Legacy generator: ${gen}`);
  if (https === false) flag(1, 'No HTTPS');

  const modern = [];
  if ($('img[srcset], picture source, img[loading="lazy"]').length) modern.push('Responsive/lazy images');
  if (/__NEXT_DATA__|data-reactroot|__NUXT__|ng-version|data-v-app|astro-island/i.test(html)) modern.push('Modern JS framework');
  if (/static\.wixstatic|squarespace|cdn\.shopify|webflow/i.test(html)) modern.push('Modern site builder');
  if ($('nav, header, main, section').length >= 2) modern.push('Semantic HTML5 structure');
  points -= modern.length;

  const verdict = points >= 4 ? 'outdated' : points >= 2 ? 'dated' : 'modern';
  return { verdict, signals, modernSignals: modern, generator: gen || null };
}

export async function analyzeWebsite(rawUrl) {
  const checkedAt = Date.now();
  let url;
  try { url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`); }
  catch { return { status: 'broken', reason: 'Invalid URL on Google listing', checkedAt, notMeasured: NOT_MEASURED }; }

  const host = url.hostname.replace(/^www\./, '');
  if (PRIVATE_HOST.test(url.hostname)) return { status: 'broken', reason: 'Private/local address', checkedAt, notMeasured: NOT_MEASURED };
  if (DEAD_BUILDERS.test(host)) return { status: 'broken', reason: 'Google business.site page (service discontinued)', finalUrl: url.href, checkedAt, notMeasured: NOT_MEASURED };
  if (SOCIAL_ONLY.test(host)) return { status: 'social_only', reason: `Listing points to ${host}, not an own website`, finalUrl: url.href, checkedAt, notMeasured: NOT_MEASURED };

  let page;
  try {
    page = await fetchHtml(url.href, 12_000);
  } catch (e) {
    // An https-only failure may be a certificate problem; try plain http before calling it broken.
    if (url.protocol === 'https:') {
      try { page = await fetchHtml(url.href.replace(/^https:/, 'http:'), 8_000); } catch { /* fall through */ }
    }
    if (!page) return { status: 'broken', reason: netReason(e), checkedAt, notMeasured: NOT_MEASURED };
  }

  const { res, html, ttfbMs, totalMs } = page;
  const finalUrl = res.url || url.href;
  // Bot protection (Cloudflare etc.) is not proof the site is broken — don't claim it is.
  if ([401, 403, 406, 429].includes(res.status) || (res.status === 503 && /cloudflare/i.test(res.headers.get('server') || ''))) {
    return { status: 'unknown', reason: `Site blocked the automated check (HTTP ${res.status}) — open it manually`, httpCode: res.status, finalUrl, responseMs: totalMs, checkedAt, notMeasured: NOT_MEASURED };
  }
  if (!res.ok) return { status: 'broken', reason: `HTTP ${res.status}`, httpCode: res.status, finalUrl, responseMs: totalMs, checkedAt, notMeasured: NOT_MEASURED };
  if (!html) return { status: 'broken', reason: 'Response is not an HTML page', httpCode: res.status, finalUrl, checkedAt, notMeasured: NOT_MEASURED };

  let https = finalUrl.startsWith('https:');
  let httpsNote = https ? 'Served over HTTPS' : null;
  if (!https) {
    try {
      const probe = await fetch(finalUrl.replace(/^http:/, 'https:'), { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(6000), headers: { 'User-Agent': UA } });
      httpsNote = probe.status < 500 ? 'HTTPS available but site does not redirect to it' : 'No working HTTPS';
    } catch { httpsNote = 'No working HTTPS'; }
  }

  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ');
  const hrefs = $('a[href]').map((_, a) => $(a).attr('href')).get();
  if (text.length < 200 && /parked|domain (is )?for sale|coming soon|under construction/i.test(html)) {
    return { status: 'broken', reason: 'Parked / coming-soon page', finalUrl, httpCode: res.status, checkedAt, notMeasured: NOT_MEASURED };
  }

  let emails = findEmails(hrefs, text);
  let whatsapp = findWhatsApp(hrefs);
  const socials = findSocials(hrefs);
  const contactHref = hrefs.find((h) => /contact|اتصل|تواصل/i.test(h) && !/^(mailto|tel|javascript):/i.test(h));
  let contactPageChecked = false;
  if (contactHref && (!emails.length || !whatsapp)) {
    try {
      const cUrl = new URL(contactHref, finalUrl);
      if (domainOf(cUrl.href) === domainOf(finalUrl)) {
        const c = await fetchHtml(cUrl.href, 8000);
        const $c = cheerio.load(c.html || '');
        const cHrefs = $c('a[href]').map((_, a) => $c(a).attr('href')).get();
        emails = emails.length ? emails : findEmails(cHrefs, $c('body').text());
        whatsapp = whatsapp || findWhatsApp(cHrefs);
        Object.assign(socials, { ...findSocials(cHrefs), ...socials });
        contactPageChecked = true;
      }
    } catch { /* contact page optional */ }
  }

  const viewport = $('meta[name="viewport"]').attr('content') || '';
  const hasViewport = /width\s*=\s*device-width/i.test(viewport);
  const mediaQueries = /@media[^{]*(max|min)-width/i.test(html);
  const mobile = {
    viewportMeta: hasViewport,
    mediaQueriesInline: mediaQueries,
    verdict: hasViewport ? 'likely' : 'unlikely',
    method: 'markup heuristic (viewport meta + inline CSS); not a rendered test',
  };

  const cta = {
    phoneLink: hrefs.some((h) => /^tel:/i.test(h)),
    emailLink: hrefs.some((h) => /^mailto:/i.test(h)),
    whatsappLink: Boolean(findWhatsApp(hrefs)),
    contactForm: $('form').filter((_, f) => $(f).find('textarea, input[type="email"]').length > 0).length > 0,
    contactPage: Boolean(contactHref),
  };
  const bookingMatch = html.match(BOOKING);

  return {
    status: 'ok',
    finalUrl,
    httpCode: res.status,
    https,
    httpsNote,
    responseMs: totalMs,
    ttfbMs,
    htmlKb: Math.round(Buffer.byteLength(html) / 1024),
    speed: totalMs < 1500 ? 'fast' : totalMs < 4000 ? 'average' : 'slow',
    title: $('title').first().text().trim().slice(0, 140) || null,
    mobile,
    design: designSignals($, html, https),
    cta: { ...cta, clear: cta.phoneLink || cta.whatsappLink || cta.contactForm },
    booking: { detected: Boolean(bookingMatch), evidence: bookingMatch?.[0] || null },
    emails, whatsapp, socials, contactPageChecked,
    checkedAt,
    notMeasured: NOT_MEASURED,
  };
}
