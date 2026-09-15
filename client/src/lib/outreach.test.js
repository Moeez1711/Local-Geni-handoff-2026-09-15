import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanOutreachTemplate, DEFAULT_SETTINGS, mergeSettings, messageFor, renderMessage, waLink } from './outreach.js';
import { previewMessage } from './previews.js';

const lead = {
  name: 'Oak Dental', category: 'Dentist', website: '', site_status: 'none',
  review_count: 120, rating: 4.8,
};

test('legacy saved settings cannot re-enable automatic contact marking', () => {
  const settings = mergeSettings({
    autoMarkContacted: true, myName: 'Asif', templates: { general: 'Hello {name}' },
  });
  assert.equal(settings.autoMarkContacted, false);
  assert.equal(settings.myName, 'Asif');
  assert.equal(settings.templates.general, 'Hello {name}');
  assert.equal(settings.templates.no_website, DEFAULT_SETTINGS.templates.no_website);
});

test('existing lead messages keep their business details and signature', () => {
  const message = messageFor(lead, mergeSettings({ myName: 'Asif', myCompany: 'Local Geni' }));
  assert.match(message, /Hi Oak Dental team/);
  assert.match(message, /rating of 4\.8 out of 5 from 120 reviews/);
  assert.match(message, /sample homepage for Oak Dental/);
  assert.match(message, /Asif, Local Geni$/);
  assert.doesNotMatch(message, /\{\w+\}/);
});

test('missing preview details leave no placeholder, invented link, or improvement', () => {
  const message = renderMessage(
    'Hi {contactName}\n{previewUrl}\n{specificImprovement}\n— {signoff}', lead, DEFAULT_SETTINGS,
  );
  assert.equal(message, 'Hi Oak Dental team');
  assert.doesNotMatch(message, /https?:|\{\w+\}/);
});

test('preview details are inserted exactly without treating their text as templates', () => {
  const context = {
    contactName: 'Sam', previewUrl: 'https://example.com/oak?view=mobile&from=asif',
    specificImprovement: 'A clearer {booking} button on mobile.',
  };
  const settings = mergeSettings({ templates: { no_website: 'Hi {contactName}\n{previewUrl}\n{specificImprovement}' } });
  assert.equal(messageFor(lead, settings, context),
    'Hi Sam\nhttps://example.com/oak?view=mobile&from=asif\nA clearer {booking} button on mobile.');
});

test('WhatsApp drafts preserve the exact message including a preview URL', () => {
  const message = 'Hi Sam 👋\nhttps://example.com/oak?a=1&b=2\nLet’s discuss this.';
  const link = new URL(waLink('+1 (555) 010-0200', message));
  assert.equal(link.pathname, '/15550100200');
  assert.equal(link.searchParams.get('text'), message);
});

test('legacy saved template decoration is removed without mutating stored input', () => {
  const legacy = 'Hi {name} team 👋\nYour rating is {rating}★.\n• Clearer booking\n— {signoff}';
  const stored = { myName: 'Asif', templates: { no_website: legacy } };
  const settings = mergeSettings(stored);
  assert.equal(settings.templates.no_website, 'Hi {name} team\nYour rating is {rating} out of 5.\n- Clearer booking\n{signoff}');
  assert.equal(stored.templates.no_website, legacy);
  assert.equal(messageFor(lead, settings), 'Hi Oak Dental team\nYour rating is 4.8 out of 5.\n- Clearer booking\nAsif');
  assert.equal(renderMessage(legacy, lead, settings), messageFor(lead, settings));
});

test('template cleanup preserves accents and non-English scripts and removes whole emoji sequences', () => {
  const template = 'Bonjour José 👋🏽\nCafé, اردو، فارسی می‌روم, हिन्दी, 中文。\n👨‍👩‍👧‍👦 🇵🇰 1️⃣ ☎ ❤\n© 2026 Studio™\nGarcía–López\nBook a call—when it suits you.';
  const cleaned = cleanOutreachTemplate(template);
  assert.match(cleaned, /Bonjour José\nCafé, اردو، فارسی می‌روم, हिन्दी, 中文。/);
  assert.match(cleaned, /© 2026 Studio™/);
  assert.match(cleaned, /García–López/);
  assert.match(cleaned, /Book a call, when it suits you\./);
  assert.doesNotMatch(cleaned, /\p{Emoji_Presentation}|\uFE0F|\u200D|\u20E3|[☎❤]/u);
});

test('cleanup acts on templates before inserting exact business and contact content', () => {
  const namedLead = { ...lead, name: 'Café Étoile ★' };
  const context = { specificImprovement: 'Keep the family name García–López exactly.' };
  const message = renderMessage('Hello {name} 👋\n{specificImprovement}', namedLead, DEFAULT_SETTINGS, context);
  assert.equal(message, 'Hello Café Étoile ★\nKeep the family name García–López exactly.');
});

test('default outreach and design introductions generate plain text without decorative symbols', () => {
  for (const template of Object.values(DEFAULT_SETTINGS.templates)) {
    const message = renderMessage(template, lead, mergeSettings({ myName: 'Asif' }));
    assert.doesNotMatch(message, /\p{Emoji_Presentation}|[★☆•—–]/u);
  }
  const message = previewMessage(lead, {
    publicUrl: 'https://localgeni.com/oak', contactName: 'José',
    improvements: ['Clearer booking', 'Services that are easy to find'],
  }, { myName: 'Asif' });
  assert.match(message, /Hi José,/);
  assert.match(message, /1\. Clearer booking\n2\. Services that are easy to find/);
  assert.doesNotMatch(message, /\p{Emoji_Presentation}|[★☆•—–]/u);
});
