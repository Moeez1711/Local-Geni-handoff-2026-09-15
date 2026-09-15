import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.DB_PATH = ':memory:';
const { db } = await import('./db.js');
const { createEmailService } = await import('./emailService.js');
const { createInboxService } = await import('./emailInbox.js');
const { createCampaignService, nextSendWindow } = await import('./emailCampaigns.js');
const accounts = await import('./emailAccounts.js');
const policy = await import('./emailPolicy.js');
const { getLead, trashLeads } = await import('./repo.js');
const KEY = Buffer.alloc(32, 3);
const APP = '11111111-2222-3333-4444-555555555555';
let clock;
test.beforeEach(() => {
  db.exec('DELETE FROM email_campaign_recipients; DELETE FROM email_campaigns; DELETE FROM email_inbox_messages; DELETE FROM email_inbox_settings; DELETE FROM email_messages; DELETE FROM email_additional_accounts; DELETE FROM email_account_preferences; DELETE FROM email_account; DELETE FROM email_suppressions; DELETE FROM email_send_reservations; DELETE FROM email_policy;');
  clock = Date.parse('2027-06-07T12:00:00Z');
});
function lead() { const id = crypto.randomUUID(); db.prepare('INSERT INTO businesses(place_id,name,category,first_seen,last_seen) VALUES(?,?,?,1,1)').run(id, 'Fictional Local Business', 'Dentist'); return id; }
function fixture(overrides = {}) {
  const sent = []; const mail = []; const imapOptions = [];
  const sender = createEmailService({ now: () => clock, keyProvider: () => KEY,
    policyHooks: { ...policy, reserveEmailSend: () => ({}) }, getDkimConfig: async () => null,
    unsubscribeLink: ({ to }) => `https://previews.example.com/u/${crypto.createHash('sha256').update(to).digest('hex')}`,
    transportFactory: () => ({ verify: async () => true, sendMail: async (m) => { sent.push(m); return { accepted: m.envelope.to }; }, close() {} }),
    fetchFn: async () => { throw new Error('No real provider requests allowed'); }, ...overrides,
  });
  const inbox = createInboxService({ service: sender, now: () => clock, keyProvider: () => KEY,
    imapFactory: async (options) => { imapOptions.push(options); return { on() {}, connect: async () => {}, logout: async () => {}, mailbox: { uidValidity: 42 },
      getMailboxLock: async (path, opts) => { assert.equal(path, 'INBOX'); assert.equal(opts.readOnly, true); return { release() {} }; },
      search: async () => mail.map((_, i) => i + 1), fetchOne: async (uid) => ({ source: Buffer.from(mail[Number(uid) - 1]), internalDate: new Date(clock) }),
    }; },
  });
  const campaigns = createCampaignService({ service: sender, inbox, now: () => clock, syncPublicOptOuts: async () => {} });
  return { sender, inbox, campaigns, sent, mail, imapOptions };
}
async function connect(f, id = 'default', email = 'asif@example.com') {
  const sender = f.sender.forAccount(id); sender.saveSettings({ provider: 'gmail', fromEmail: email, fromName: 'Asif', password: 'TEST_PASSWORD' }); await sender.verify();
  f.inbox.saveSettings(id, { enabled: true }); await f.inbox.verify(id);
  return sender;
}
function campaignBody(placeId, overrides = {}) { return { name: 'Local homepage follow-ups', accountId: 'default', timezone: 'UTC', sendWindow: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
  recipients: [{ placeId, to: 'owner@example.com' }], steps: [{ subject: 'A homepage for {businessName}', text: 'Your {category} homepage concept is ready.', delayHours: 0 }, { subject: 'Following up', text: 'Would you like to discuss the homepage?', delayHours: 24 }], ...overrides }; }
function startCampaign(f, body = campaignBody(lead())) { const draft = f.campaigns.create(body); const review = f.campaigns.review(draft.id); f.campaigns.start(draft.id, { reviewToken: review.reviewToken, confirmed: true }); return { id: draft.id, review }; }

test('additional accounts isolate secrets, sender selection and send history without migrating away the primary account', async () => {
  const f = fixture(); await connect(f); const additional = accounts.createAccount({ label: 'Second sender' }); await connect(f, additional, 'second@example.com');
  accounts.selectAccount(additional);
  assert.equal(accounts.currentAccountId(), additional); assert.equal(f.sender.getSettings().fromEmail, 'asif@example.com');
  const second = f.sender.forAccount(additional); const p = second.prepare({ placeId: lead(), to: 'owner@example.com', subject: 'Hi', text: 'Homepage concept' });
  const result = await second.sendEmail({ ...p, idempotencyKey: 'named-account-send', confirmed: true });
  assert.equal(result.message.accountId, additional); assert.equal(f.sent[0].from.address, 'second@example.com');
  assert.equal(f.sender.listMessages().rows.length, 0); assert.equal(second.listMessages().rows.length, 1);
  assert.ok(db.prepare('SELECT encrypted_secret FROM email_account').get().encrypted_secret);
  assert.ok(!JSON.stringify(second.getSettings()).includes('TEST_PASSWORD'));
});

test('Gmail, Microsoft and SMTP coexist and changing the current mailbox cannot redirect a reviewed send', async () => {
  const submitted = [], graph = [];
  const f = fixture({
    transportFactory: options => ({ verify: async () => true, close() {}, sendMail: async message => {
      submitted.push({ host: options.host, user: options.auth.user, from: message.from.address });
      return { accepted: message.envelope.to };
    } }),
    fetchFn: async (url, options) => {
      if (url.endsWith('/devicecode')) return Response.json({ device_code: 'all-provider-device', user_code: 'QA-CODE', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 });
      if (url.endsWith('/token')) return Response.json({ access_token: 'MICROSOFT_ONLY_TOKEN', refresh_token: 'MICROSOFT_REFRESH', expires_in: 3600, scope: 'Mail.Send User.Read' });
      if (url.includes('/me?')) return Response.json({ mail: 'outlook@example.com', displayName: 'Microsoft sender' });
      if (url.endsWith('/sendMail')) { graph.push(options); return new Response(null, { status: 202 }); }
      throw new Error('Unexpected provider request');
    },
  });
  const gmail = await connect(f, 'default', 'google@example.com');
  const smtpId = accounts.createAccount({ label: 'SMTP sender' }), microsoftId = accounts.createAccount({ label: 'Microsoft sender' });
  const smtp = f.sender.forAccount(smtpId), microsoft = f.sender.forAccount(microsoftId);
  smtp.saveSettings({ provider: 'smtp', fromEmail: 'smtp@example.com', host: 'smtp.provider.com', port: 587, username: 'smtp-user', password: 'SMTP_ONLY_SECRET' });
  await smtp.verify();
  await microsoft.startMicrosoft({ clientId: APP }); clock += 5000; await microsoft.pollMicrosoft();
  assert.equal(submitted.length + graph.length, 0, 'connection setup never submits an email');
  const senders = [gmail, smtp, microsoft];
  const reviews = senders.map(sender => sender.prepare({ placeId: lead(), to: 'owner@example.com', subject: 'A reviewed design', text: 'Here is the finished homepage link.' }));
  accounts.selectAccount(microsoftId);
  for (let i = 0; i < senders.length; i++) {
    const result = await senders[i].sendEmail({ ...reviews[i], confirmed: true, idempotencyKey: `all-providers-${i}` });
    assert.equal(result.message.accountId, ['default', smtpId, microsoftId][i]);
    assert.equal(result.message.fromEmail, ['google@example.com', 'smtp@example.com', 'outlook@example.com'][i]);
    assert.equal(senders[i].listMessages().rows.length, 1);
  }
  assert.deepEqual(submitted, [
    { host: 'smtp.gmail.com', user: 'google@example.com', from: 'google@example.com' },
    { host: 'smtp.provider.com', user: 'smtp-user', from: 'smtp@example.com' },
  ]);
  assert.equal(graph.length, 1);
  assert.equal(graph[0].headers.Authorization, 'Bearer MICROSOFT_ONLY_TOKEN');
  const exposed = JSON.stringify(senders.map(sender => ({ settings: sender.getSettings(), messages: sender.listMessages() })));
  assert.doesNotMatch(exposed, /SMTP_ONLY_SECRET|MICROSOFT_ONLY_TOKEN|MICROSOFT_REFRESH|TEST_PASSWORD/);
});

test('real MIME parsing plus read-only IMAP sync correlates replies and stops remaining sequence messages', async () => {
  const f = fixture(); await connect(f); const placeId = lead(); const { id, review } = startCampaign(f, campaignBody(placeId));
  await f.campaigns.tick(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].text, review.messages[0].text);
  const original = f.sender.listMessages().rows[0]; clock += 3600000;
  f.mail.push(`From: Owner <owner@example.com>\r\nTo: asif@example.com\r\nMessage-ID: <reply-1@example.com>\r\nIn-Reply-To: ${original.providerMessageId}\r\nSubject: Re: Homepage\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYes, let's discuss it.\r\n`);
  await f.campaigns.tick();
  assert.equal(f.campaigns.detail(id).recipients[0].status, 'stopped');
  assert.equal(f.campaigns.detail(id).recipients[0].stopReason, 'reply');
  assert.equal(f.inbox.list().rows[0].placeId, placeId); assert.equal(f.inbox.list().rows[0].kind, 'reply');
  assert.equal(f.imapOptions[0].secure, true); assert.equal(f.imapOptions[0].port, 993); assert.equal(f.imapOptions[0].logger, false);
  clock += 3 * 86400000; await f.campaigns.tick(); assert.equal(f.sent.length, 1);
});

test('opt-outs and delivery-status bounces suppress the recipient, while unrelated references cannot impersonate a reply', async () => {
  const f = fixture(); await connect(f); const placeId = lead(); const p = f.sender.prepare({ placeId, to: 'owner@example.com', subject: 'Homepage', text: 'A concept' });
  const original = (await f.sender.sendEmail({ ...p, confirmed: true, idempotencyKey: 'outbound-reference' })).message;
  let result = f.inbox.ingest('default', { remoteId: 'spoof', fromEmail: 'stranger@example.org', inReplyTo: original.providerMessageId, text: 'No thanks', receivedAt: clock + 1 });
  assert.equal(result.kind, 'unmatched');
  result = f.inbox.ingest('default', { remoteId: 'optout', fromEmail: 'owner@example.com', inReplyTo: original.providerMessageId, text: 'No thanks, remove me.', receivedAt: clock + 2 });
  assert.equal(result.kind, 'opt_out'); assert.throws(() => policy.assertRecipientAllowed('OWNER@example.com'), (e) => e.code === 'RECIPIENT_SUPPRESSED');
  policy.removeSuppression('owner@example.com');
  result = f.inbox.ingest('default', { remoteId: 'bounce', fromEmail: 'mailer-daemon@example.com', text: 'Final-Recipient: rfc822; owner@example.com\nAction: failed\nStatus: 5.1.1', headers: { 'content-type': 'multipart/report; report-type=delivery-status' }, receivedAt: clock + 3 });
  assert.equal(result.kind, 'bounce'); assert.equal(policy.listSuppressions()[0].reason, 'bounced');
});

test('draft creation never schedules work and a stale reviewed sender or policy cannot start a campaign', async () => {
  const f = fixture(); await connect(f); const draft = f.campaigns.create(campaignBody(lead())); await f.campaigns.tick(); assert.equal(f.sent.length, 0);
  const reviewed = f.campaigns.review(draft.id); policy.updateEmailPolicy({ minIntervalSeconds: 180 });
  assert.throws(() => f.campaigns.start(draft.id, { reviewToken: reviewed.reviewToken, confirmed: true }), (e) => e.code === 'CAMPAIGN_REVIEW_REQUIRED');
  assert.equal(f.campaigns.detail(draft.id).status, 'draft');
});

test('scheduled work respects timezone quiet windows, exact approved content, delays, pause and explicit resume', async () => {
  const f = fixture(); await connect(f); clock = Date.parse('2027-06-07T07:00:00Z');
  const { id, review } = startCampaign(f); await f.campaigns.tick(); assert.equal(f.sent.length, 0);
  clock = Date.parse('2027-06-07T09:00:00Z'); await f.campaigns.tick(); assert.equal(f.sent.length, 1);
  f.campaigns.action(id, 'pause'); clock += 86400000; await f.campaigns.tick(); assert.equal(f.sent.length, 1);
  f.campaigns.action(id, 'resume'); await f.campaigns.tick(); assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].text, review.messages[1].text); assert.equal(f.campaigns.detail(id).status, 'completed');
  assert.equal(nextSendWindow(Date.parse('2027-06-11T18:00:00Z'), 'UTC', { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] }), Date.parse('2027-06-14T09:00:00Z'));
  assert.equal(nextSendWindow(Date.parse('2027-03-14T06:30:00Z'), 'America/New_York', { start: '03:00', end: '04:00', days: [7] }), Date.parse('2027-03-14T07:00:00Z'));
});

test('campaigns fail closed when inbox or public opt-out sync is unavailable', async () => {
  const f = fixture(); await connect(f); const { id } = startCampaign(f);
  const unavailable = createCampaignService({ service: f.sender, now: () => clock, inbox: { sync: async () => { throw new Error('offline'); } }, syncPublicOptOuts: async () => {} });
  await unavailable.tick(); assert.equal(f.sent.length, 0); assert.match(f.campaigns.detail(id).holdReason, /inbox sync/);
  const relayDown = createCampaignService({ service: f.sender, inbox: f.inbox, now: () => clock, syncPublicOptOuts: async () => { throw new Error('relay offline'); } });
  assert.equal((await relayDown.tick()).held, 1); assert.match(f.campaigns.detail(id).holdReason, /unsubscribe sync/); assert.equal(f.sent.length, 0);
});

test('uncertain scheduled sends are durable terminal outcomes and are never retried', async () => {
  let tries = 0;
  const f = fixture({ transportFactory: () => ({ verify: async () => true, sendMail: async () => { tries++; throw Object.assign(new Error('connection lost'), { code: 'ECONNECTION', command: 'DATA' }); }, close() {} }) });
  await connect(f); const { id } = startCampaign(f); await f.campaigns.tick(); assert.equal(f.campaigns.detail(id).recipients[0].status, 'unknown');
  clock += 86400000; await f.campaigns.tick(); assert.equal(tries, 1);
});

test('paused review includes only future emails for pending recipients, never already sent or opted-out recipients', async () => {
  const f = fixture(); await connect(f); const { id } = startCampaign(f); await f.campaigns.tick(); f.campaigns.action(id, 'pause');
  const review = f.campaigns.review(id); assert.equal(review.messages.length, 1); assert.equal(review.messages[0].stepIndex, 1);
});

test('Microsoft inbox reconsent requests Mail.Read and Graph standard threading/unsubscribe headers use valid MIME', async () => {
  const requests = [];
  const f = fixture({ fetchFn: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/devicecode')) return Response.json({ device_code: 'device', user_code: 'USERCODE', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 });
    if (url.endsWith('/token')) return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'Mail.Read Mail.Send User.Read' });
    if (url.includes('/me?')) return Response.json({ mail: 'asif@example.com', displayName: 'Asif' });
    if (url.endsWith('/sendMail')) return new Response(null, { status: 202 });
    throw new Error('Unexpected provider path');
  } });
  await f.sender.startMicrosoft({ clientId: APP, inbox: true }); clock += 5000; await f.sender.pollMicrosoft();
  assert.match(requests[0].options.body, /Mail.Read/);
  const prepared = f.sender.prepare({ placeId: lead(), to: 'owner@example.com', subject: 'Re: Homepage', text: 'Your reply.', inReplyTo: '<original@example.com>', references: ['<original@example.com>'] });
  const response = await f.sender.sendEmail({ ...prepared, confirmed: true, idempotencyKey: 'microsoft-mime-send' }); assert.equal(response.message.status, 'sent');
  const sent = requests.find((r) => r.url.endsWith('/sendMail')); assert.equal(sent.options.headers['Content-Type'], 'text/plain');
  const raw = Buffer.from(sent.options.body, 'base64'); const parsed = await (await import('mailparser')).simpleParser(raw);
  assert.equal(parsed.inReplyTo, '<original@example.com>'); assert.match(raw.toString(), /^List-Unsubscribe-Post: List-Unsubscribe=One-Click\r?$/m);
  assert.equal(parsed.text.trimEnd(), prepared.text.trimEnd()); assert.match(raw.toString().split('\r\n\r\n')[0].replace(/\r\n[ \t]+/g, ' '), /^List-Unsubscribe: <https:\/\/previews\.example\.com\/u\/[^>]+>\r?$/m);
});

test('manual sends synchronize public opt-outs and recheck suppression immediately before submission', async () => {
  let synchronized = false;
  const f = fixture({ syncPublicOptOuts: async () => { synchronized = true; policy.addSuppression({ email: 'owner@example.com', reason: 'opt_out' }); } }); await connect(f);
  const p = f.sender.prepare({ placeId: lead(), to: 'owner@example.com', subject: 'Hi', text: 'Hello' });
  await assert.rejects(f.sender.sendEmail({ ...p, idempotencyKey: 'public-optout-race', confirmed: true }), (e) => e.code === 'RECIPIENT_SUPPRESSED');
  assert.equal(synchronized, true); assert.equal(f.sent.length, 0); assert.equal(getLead(p.placeId).last_contacted_at, null);
});
test('IMAP credentials survive enable toggles and sender display edits, while a changed host discards the old credential', async () => {
  const f = fixture(); const sender = f.sender;
  sender.saveSettings({ provider: 'smtp', fromEmail: 'sender@example.com', host: 'smtp.example.com', port: 465, username: 'sender@example.com', password: 'SMTP_SECRET' }); await sender.verify();
  f.inbox.saveSettings('default', { enabled: true, host: 'imap.example.com', username: 'sender@example.com', password: 'IMAP_SECRET' }); await f.inbox.verify('default');
  const sealed = db.prepare('SELECT encrypted_secret FROM email_inbox_settings').get().encrypted_secret;
  f.inbox.saveSettings('default', { enabled: false }); f.inbox.saveSettings('default', { enabled: true }); await f.inbox.verify('default');
  assert.equal(db.prepare('SELECT encrypted_secret FROM email_inbox_settings').get().encrypted_secret, sealed);
  sender.saveSettings({ fromName: 'Updated name' }); f.inbox.saveSettings('default', { enabled: true }); await f.inbox.verify('default');
  assert.equal(f.imapOptions.at(-1).auth.pass, 'IMAP_SECRET');
  const changed = f.inbox.saveSettings('default', { enabled: true, host: 'different.example.com' });
  assert.equal(changed.configured, false); assert.equal(changed.verified, false);
});

test('paused campaign reapproval excludes terminal recipients and removing suppression cannot revive them', async () => {
  const f = fixture(); await connect(f);
  const { id } = startCampaign(f, campaignBody(lead(), { recipients: [{ placeId: lead(), to: 'owner@example.com' }, { placeId: lead(), to: 'second@example.com' }] }));
  await f.campaigns.tick(); f.campaigns.action(id, 'pause');
  policy.addSuppression({ email: 'owner@example.com', reason: 'opt_out' });
  const review = f.campaigns.review(id); assert.ok(review.messages.every((m) => m.to === 'second@example.com'));
  f.campaigns.start(id, { reviewToken: review.reviewToken, confirmed: true }); policy.removeSuppression('owner@example.com');
  assert.equal(f.campaigns.detail(id).recipients.find((r) => r.to === 'owner@example.com').status, 'stopped');
  await f.campaigns.tick(); assert.equal(f.sent.at(-1).to[0].address, 'second@example.com');
});

test('removing a named sender pauses its campaigns and preserves history without stopping other inbox checks', async () => {
  const f = fixture(); const id = accounts.createAccount({ label: 'Secondary' }); await connect(f, id, 'second@example.com');
  const campaign = startCampaign(f, campaignBody(lead(), { accountId: id }));
  accounts.deleteAccount(id); assert.equal(f.campaigns.detail(campaign.id).status, 'paused');
  await f.campaigns.tick(); assert.equal(f.sent.length, 0); assert.throws(() => f.sender.forAccount(id), (e) => e.code === 'EMAIL_ACCOUNT_NOT_FOUND');
});

test('restart recovery marks in-flight named-account submissions uncertain, never eligible for retry', async () => {
  const f = fixture(); const id = accounts.createAccount({ label: 'Secondary' }); const sender = await connect(f, id, 'second@example.com');
  const prepared = sender.prepare({ placeId: lead(), to: 'owner@example.com', subject: 'Hello', text: 'Concept' });
  const result = await sender.sendEmail({ ...prepared, idempotencyKey: 'restart-named-account', confirmed: true });
  db.prepare("UPDATE email_messages SET status='sending' WHERE id=?").run(result.message.id);
  const restarted = fixture(); const message = restarted.sender.forAccount(id).listMessages().rows[0];
  assert.equal(message.status, 'unknown'); assert.equal(message.errorCode, 'PROCESS_INTERRUPTED');
  const retried = await restarted.sender.forAccount(id).sendEmail({ ...prepared, idempotencyKey: 'restart-named-account', confirmed: true });
  assert.equal(retried.message.status, 'unknown'); assert.equal(restarted.sent.length, 0);
});

test('a campaign paused during asynchronous preflight makes no submission and resumes only on explicit action', async () => {
  let pause = () => {};
  const f = fixture({ syncPublicOptOuts: async () => pause() }); await connect(f); const { id } = startCampaign(f);
  pause = () => f.campaigns.action(id, 'pause');
  await f.campaigns.tick(); assert.equal(f.sent.length, 0); assert.equal(f.campaigns.detail(id).status, 'paused');
  pause = () => {}; f.campaigns.action(id, 'resume'); await f.campaigns.tick(); assert.equal(f.sent.length, 1);
});

test('lead deletion during asynchronous preflight prevents manual submission', async () => {
  const placeId = lead(); const f = fixture({ syncPublicOptOuts: async () => { db.prepare('UPDATE businesses SET deleted_at=? WHERE place_id=?').run(clock, placeId); } }); await connect(f);
  const p = f.sender.prepare({ placeId, to: 'owner@example.com', subject: 'Homepage', text: 'Concept' });
  await assert.rejects(f.sender.sendEmail({ ...p, confirmed: true, idempotencyKey: 'deleted-during-preflight' }), (e) => e.code === 'BUSINESS_NOT_FOUND');
  assert.equal(f.sent.length, 0); assert.equal(f.sender.listMessages().rows[0].status, 'failed');
});

test('trashing a lead stops pending follow-ups and restoration never restarts them', async () => {
  const f = fixture(); await connect(f); const placeId = lead(); const { id } = startCampaign(f, campaignBody(placeId));
  await f.campaigns.tick(); assert.equal(f.sent.length, 1);
  trashLeads([placeId]); assert.equal(f.campaigns.detail(id).recipients[0].status, 'stopped');
  trashLeads([placeId], true); clock += 86400000; await f.campaigns.tick();
  assert.ok(getLead(placeId)); assert.equal(f.sent.length, 1); assert.equal(f.campaigns.detail(id).recipients[0].status, 'stopped');
});

test('Graph delta sync persists a provider folder cursor, deduplicates replies, and never forwards credentials to an untrusted cursor', async () => {
  let cursor = 'https://graph.microsoft.com/v1.0/me/mailFolders/AAMkEncodedFolderId=/messages/delta?$deltatoken=one';
  let original; const requests = [];
  const f = fixture({ fetchFn: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/devicecode')) return Response.json({ device_code: 'device', user_code: 'CODE', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 });
    if (url.endsWith('/token')) return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'Mail.Read Mail.Send User.Read' });
    if (url.includes('/me?')) return Response.json({ mail: 'asif@example.com' });
    if (url.endsWith('/sendMail')) return new Response(null, { status: 202 });
    if (url.includes('/messages/delta')) return Response.json({ '@odata.deltaLink': cursor, value: [{ id: 'one', internetMessageId: '<reply@example.com>', from: { emailAddress: { address: 'owner@example.com', name: 'Owner' } }, toRecipients: [{ emailAddress: { address: 'asif@example.com' } }], internetMessageHeaders: [{ name: 'In-Reply-To', value: original.providerMessageId }], subject: 'Re: Homepage', body: { contentType: 'text', content: 'Happy to discuss.' }, receivedDateTime: new Date(clock).toISOString() }] });
    if (url.includes('/mailFolders/inbox?')) return Response.json({ id: 'inbox' });
    throw new Error('Unexpected provider request');
  } });
  await f.sender.startMicrosoft({ clientId: APP, inbox: true }); clock += 5000; await f.sender.pollMicrosoft();
  f.inbox.saveSettings('default', { enabled: true }); await f.inbox.verify('default');
  const prepared = f.sender.prepare({ placeId: lead(), to: 'owner@example.com', subject: 'Homepage', text: 'Concept' });
  original = (await f.sender.sendEmail({ ...prepared, confirmed: true, idempotencyKey: 'graph-inbox-outgoing' })).message;
  await f.inbox.sync('default'); assert.equal(f.inbox.list().rows[0].kind, 'reply'); await f.inbox.sync('default'); assert.equal(f.inbox.list().rows.length, 1);
  assert.ok(requests.some((r) => r.url === cursor)); assert.ok(requests.every((r) => r.options.redirect === 'error'));
  cursor = 'https://attacker.example/steal-token';
  await assert.rejects(f.inbox.sync('default'), (e) => e.code === 'INVALID_GRAPH_CURSOR');
  assert.ok(requests.every((r) => !r.url.includes('attacker.example')));
});

test('reviewed campaign content uses the saved external public URL and keeps that exact approved link after later project edits', async () => {
  const { savePreview } = await import('./previewRepo.js');
  const f = fixture(); await connect(f); const placeId = lead();
  savePreview(placeId, { publicUrl: 'https://designs.studio.com/approved-homepage', stage: 'ready' });
  const { id, review } = startCampaign(f, campaignBody(placeId, { steps: [{ subject: 'Your homepage', text: 'View the design: {previewUrl}', delayHours: 0 }] }));
  assert.ok(review.messages[0].text.includes('https://designs.studio.com/approved-homepage'));
  savePreview(placeId, { publicUrl: 'https://designs.studio.com/later-edit' }); await f.campaigns.tick();
  assert.equal(f.campaigns.detail(id).status, 'completed'); assert.equal(f.sent[0].text, review.messages[0].text);
  assert.ok(!f.sent[0].text.includes('later-edit'));
});

test.after(() => db.close());
