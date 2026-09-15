import crypto from 'node:crypto';
import { db, json, tx } from './db.js';
import { emailService } from './emailService.js';
import { inboxService, stopRecipientSequences } from './emailInbox.js';
import { assertAccountId, inboxSettings, accountIds } from './emailAccounts.js';
import { getLead } from './repo.js';
import { getPreview, externalPublicUrl } from './previewRepo.js';
import { emailError, normalizeEmail, getEmailPolicy, assertRecipientAllowed, getPolicyStatus } from './emailPolicy.js';

db.exec(`CREATE TABLE IF NOT EXISTS email_campaigns (
 id TEXT PRIMARY KEY,name TEXT NOT NULL,account_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',
 config_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,approved_json TEXT,hold_reason TEXT,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS email_campaign_recipients (
 campaign_id TEXT NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,place_id TEXT NOT NULL,to_email TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',next_step INTEGER NOT NULL DEFAULT 0,next_run_at INTEGER NOT NULL,
 stop_reason TEXT,last_message_id TEXT,PRIMARY KEY(campaign_id,to_email));
 CREATE INDEX IF NOT EXISTS idx_email_campaign_due ON email_campaign_recipients(status,next_run_at);
`);
if (!db.prepare('PRAGMA table_info(email_campaign_recipients)').all().some((c) => c.name === 'attempt')) db.exec('ALTER TABLE email_campaign_recipients ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0');
let publicSync = async () => {};
export function setEmailCampaignPublicSync(fn) { publicSync = fn; }
const digest = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fmtCache = new Map();
export function nextSendWindow(timestamp, timezone, window) {
  if (!fmtCache.has(timezone)) fmtCache.set(timezone, new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  const format = fmtCache.get(timezone); const minute = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const start = minute(window.start); const end = minute(window.end); const days = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  for (let i = 0; i < 8 * 1440; i++) {
    const at = i === 0 ? timestamp : Math.floor(timestamp / 60000) * 60000 + i * 60000;
    const p = Object.fromEntries(format.formatToParts(at).map((v) => [v.type, v.value])); const m = Number(p.hour) * 60 + Number(p.minute);
    if (window.days.includes(days[p.weekday]) && (start < end ? m >= start && m < end : m >= start || m < end)) return at;
  }
  throw emailError(400, 'INVALID_SEND_WINDOW', 'Choose at least one sending day and a valid time window.');
}
function validate(body) {
  if (!body || typeof body !== 'object') throw emailError(400, 'INVALID_CAMPAIGN', 'Enter campaign settings.');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120) throw emailError(400, 'INVALID_CAMPAIGN', 'Enter a campaign name of 120 characters or fewer.');
  const accountId = assertAccountId(body.accountId || 'default');
  const timezone = body.timezone || 'Asia/Karachi';
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); } catch { throw emailError(400, 'INVALID_TIMEZONE', 'Choose a valid time zone.'); }
  const sendWindow = body.sendWindow || { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] };
  if (![sendWindow.start, sendWindow.end].every((s) => typeof s === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s)) || sendWindow.start === sendWindow.end || !Array.isArray(sendWindow.days) || !sendWindow.days.length || sendWindow.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw emailError(400, 'INVALID_SEND_WINDOW', 'Choose sending days and a start and end time.');
  if (!Array.isArray(body.recipients) || !body.recipients.length || body.recipients.length > 25) throw emailError(400, 'INVALID_RECIPIENTS', 'Choose between 1 and 25 recipients per reviewed campaign.');
  const recipients = body.recipients.map((r) => { if (!getLead(r.placeId)) throw emailError(404, 'BUSINESS_NOT_FOUND', 'A selected business no longer exists.'); return { placeId: r.placeId, to: normalizeEmail(r.to) }; });
  if (new Set(recipients.map((r) => r.to)).size !== recipients.length) throw emailError(400, 'DUPLICATE_RECIPIENT', 'Each email address can appear only once in a campaign.');
  if (!Array.isArray(body.steps) || !body.steps.length || body.steps.length > 5) throw emailError(400, 'INVALID_STEPS', 'Add between 1 and 5 emails.');
  const steps = body.steps.map((s) => {
    if (typeof s.subject !== 'string' || !s.subject.trim() || s.subject.length > 200 || /[\r\n\0]/.test(s.subject) || typeof s.text !== 'string' || !s.text.trim() || s.text.length > 9000 || !Number.isFinite(s.delayHours ?? 0) || (s.delayHours ?? 0) < 0 || (s.delayHours ?? 0) > 8760) throw emailError(400, 'INVALID_STEP', 'Each email needs a subject, message, and delay from 0 to 8760 hours.');
    return { subject: s.subject, text: s.text, delayHours: s.delayHours ?? 0 };
  });
  return { name, accountId, timezone, sendWindow: { start: sendWindow.start, end: sendWindow.end, days: [...new Set(sendWindow.days)] }, recipients, steps };
}

export function createCampaignService({ service = emailService, inbox = inboxService, now = () => Date.now(), syncPublicOptOuts = () => publicSync() } = {}) {
  const reviewKey = crypto.randomBytes(32); let ticking = false; let timer;
  const row = (id) => { const r = db.prepare('SELECT * FROM email_campaigns WHERE id=?').get(id); if (!r) throw emailError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found.'); return r; };
  function detail(id) {
    const r = row(id); const c = json(r.config_json); const recipients = db.prepare('SELECT place_id AS placeId,to_email AS "to",status,next_step AS nextStep,next_run_at AS nextRunAt,stop_reason AS stopReason,last_message_id AS lastMessageId FROM email_campaign_recipients WHERE campaign_id=?').all(id);
    const states = recipients.length ? recipients : c.recipients.map((recipient) => ({ ...recipient, status: 'pending', nextStep: 0, nextRunAt: null }));
    const counts = { pending: 0, sent: 0, stopped: 0, failed: 0, unknown: 0 };
    for (const recipient of states) if (counts[recipient.status] !== undefined) counts[recipient.status]++;
    const nextRunAt = recipients.filter((v) => v.status === 'pending').reduce((min, v) => Math.min(min, v.nextRunAt), Infinity);
    const messages = db.prepare('SELECT id,place_id AS placeId,to_email AS "to",subject,text,status,created_at AS createdAt,accepted_at AS acceptedAt,error_code AS errorCode FROM email_messages WHERE idempotency_key LIKE ? ORDER BY created_at').all(`campaign:${id}:%`);
    return { id, ...c, status: r.status, revision: r.revision, recipients: states, counts, messages, holdReason: r.hold_reason, nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : null, createdAt: r.created_at, updatedAt: r.updated_at, workerRequiresOpenApp: true };
  }
  function list() { return { rows: db.prepare('SELECT id FROM email_campaigns ORDER BY updated_at DESC').all().map((r) => detail(r.id)) }; }
  function create(body) { const c = validate(body); const id = crypto.randomUUID(); db.prepare('INSERT INTO email_campaigns(id,name,account_id,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, c.name, c.accountId, JSON.stringify(c), now(), now()); return detail(id); }
  function update(id, body) { const r = row(id); if (r.status !== 'draft') throw emailError(409, 'CAMPAIGN_NOT_DRAFT', 'Only a draft campaign can be edited.'); const c = validate(body); db.prepare('UPDATE email_campaigns SET name=?,account_id=?,config_json=?,revision=revision+1,approved_json=NULL,updated_at=? WHERE id=?').run(c.name, c.accountId, JSON.stringify(c), now(), id); return detail(id); }
  function expanded(c, minSteps = new Map()) {
    const sender = service.forAccount(c.accountId); const output = [];
    for (const recipient of c.recipients) {
      assertRecipientAllowed(recipient.to); const { lead, preview } = getPreview(recipient.placeId);
      const variables = { businessName: lead.name, contactName: preview.contactName || '', city: '', category: lead.category || '', previewUrl: externalPublicUrl(preview), specificImprovement: preview.improvements?.[0] || '' };
      const expand = (s) => s.replace(/\{(businessName|contactName|city|category|previewUrl|specificImprovement)\}/g, (_, key) => variables[key]);
      let after = 0;
      for (const [stepIndex, step] of c.steps.entries()) {
        after += step.delayHours;
        if (stepIndex < (minSteps.get(recipient.to) || 0)) continue;
        const p = sender.prepare({ placeId: recipient.placeId, to: recipient.to, subject: expand(step.subject), text: expand(step.text) });
        if (!p.unsubscribeUrl) throw emailError(409, 'PUBLIC_UNSUBSCRIBE_REQUIRED', 'Connect email unsubscribe links before starting a campaign.');
        const { reviewToken, expiresAt, ...message } = p;
        output.push({ ...message, stepIndex, scheduledAfterHours: after });
      }
    }
    return output;
  }
  const binding = (r, messages) => digest({ id: r.id, revision: r.revision, accountRevision: service.forAccount(r.account_id).getSettings().revision, policyRevision: getEmailPolicy().revision, messages });
  function review(id) {
    const r = row(id); if (!['draft', 'paused'].includes(r.status)) throw emailError(409, 'CAMPAIGN_REVIEW_STATE', 'Pause this campaign before reviewing it.');
    const config = json(r.config_json); const minSteps = new Map();
    if (r.status === 'paused') {
      const remaining = db.prepare("SELECT to_email,next_step FROM email_campaign_recipients WHERE campaign_id=? AND status='pending'").all(id);
      config.recipients = config.recipients.filter((recipient) => remaining.some((r) => r.to_email === recipient.to));
      for (const recipient of remaining) minSteps.set(recipient.to_email, recipient.next_step);
    }
    const messages = expanded(config, minSteps);
    if (!messages.length) throw emailError(409, 'CAMPAIGN_FINISHED', 'There are no remaining messages to review.');
    const expiresAt = now() + 15 * 60000;
    const data = Buffer.from(JSON.stringify({ binding: binding(r, messages), expiresAt, nonce: crypto.randomUUID() })).toString('base64url');
    const reviewToken = `${data}.${crypto.createHmac('sha256', reviewKey).update(data).digest('base64url')}`;
    // Only a reviewed snapshot can become durable approval. Saving a draft never schedules work.
    db.prepare('UPDATE email_campaigns SET approved_json=? WHERE id=?').run(JSON.stringify({ messages, reviewToken, expiresAt, approved: false }), id);
    return { campaign: detail(id), messages, reviewToken, expiresAt };
  }
  function start(id, body = {}) {
    const r = row(id); const approved = json(r.approved_json);
    if (!['draft', 'paused'].includes(r.status) || body.confirmed !== true || !approved || body.reviewToken !== approved.reviewToken || approved.expiresAt <= now()) throw emailError(409, 'CAMPAIGN_REVIEW_REQUIRED', 'Review every exact email before starting this campaign.');
    const [data, signature] = body.reviewToken.split('.'); const expected = crypto.createHmac('sha256', reviewKey).update(data).digest('base64url');
    const decoded = json(Buffer.from(data, 'base64url').toString('utf8'));
    if (signature !== expected || decoded?.binding !== binding(r, approved.messages)) throw emailError(409, 'CAMPAIGN_REVIEW_REQUIRED', 'The sender or sending rules changed. Review the campaign again.');
    const c = json(r.config_json); const inboxConfig = inboxSettings(c.accountId);
    if (!inboxConfig.enabled || !inboxConfig.verified) throw emailError(409, 'INBOX_REQUIRED', 'Enable and verify this sender’s inbox before starting automatic follow-ups.');
    const sender = service.forAccount(c.accountId).getSettings();
    tx(() => {
      for (const recipient of c.recipients) {
        if (!approved.messages.some((message) => message.to.toLowerCase() === recipient.to)) continue;
        const prior = db.prepare('SELECT status FROM email_campaign_recipients WHERE campaign_id=? AND to_email=?').get(id, recipient.to);
        if (prior && prior.status !== 'pending') continue;
        if (!getLead(recipient.placeId)) throw emailError(404, 'BUSINESS_NOT_FOUND', 'A selected business was removed. Review the remaining campaign again.');
        assertRecipientAllowed(recipient.to);
        db.prepare('INSERT OR IGNORE INTO email_campaign_recipients(campaign_id,place_id,to_email,next_run_at) VALUES(?,?,?,?)').run(id, recipient.placeId, recipient.to, nextSendWindow(now() + c.steps[0].delayHours * 3600000, c.timezone, c.sendWindow));
      }
      db.prepare("UPDATE email_campaigns SET status='active',approved_json=?,hold_reason=NULL,updated_at=? WHERE id=?").run(JSON.stringify({ ...approved, approved: true, accountRevision: sender.revision, policyRevision: getEmailPolicy().revision }), now(), id);
    });
    return detail(id);
  }
  function action(id, action) {
    const r = row(id);
    if (['completed', 'cancelled'].includes(r.status)) throw emailError(409, 'CAMPAIGN_FINISHED', 'This campaign has already finished.');
    if (action === 'resume') {
      const approval = json(r.approved_json); const settings = service.forAccount(r.account_id).getSettings();
      if (r.status !== 'paused' || !approval?.approved || approval.accountRevision !== settings.revision || approval.policyRevision !== getEmailPolicy().revision) throw emailError(409, 'CAMPAIGN_REVIEW_REQUIRED', 'Review this campaign again before resuming.');
      db.prepare("UPDATE email_campaigns SET status='active',hold_reason=NULL,updated_at=? WHERE id=?").run(now(), id);
    } else if (action === 'pause') db.prepare("UPDATE email_campaigns SET status='paused',updated_at=? WHERE id=?").run(now(), id);
    else if (action === 'cancel') tx(() => { db.prepare("UPDATE email_campaigns SET status='cancelled',updated_at=? WHERE id=?").run(now(), id); db.prepare("UPDATE email_campaign_recipients SET status='stopped',stop_reason='campaign_cancelled' WHERE campaign_id=? AND status='pending'").run(id); });
    else throw emailError(400, 'INVALID_CAMPAIGN_ACTION', 'Choose pause, resume, or cancel.');
    return detail(id);
  }
  const hold = (id, message) => db.prepare('UPDATE email_campaigns SET hold_reason=?,updated_at=? WHERE id=?').run(message, now(), id);
  async function tick() {
    if (ticking) return { busy: true }; ticking = true;
    const result = { synced: 0, sent: 0, held: 0 };
    try {
      const activeCampaigns = db.prepare("SELECT * FROM email_campaigns WHERE status='active' ORDER BY created_at").all();
      const enabledAccounts = accountIds().filter((id) => inboxSettings(id).enabled && inboxSettings(id).verified);
      if (!activeCampaigns.length && !enabledAccounts.length) return result;
      try { await syncPublicOptOuts(); } catch {
        for (const campaign of activeCampaigns) hold(campaign.id, 'Waiting for a successful public unsubscribe sync before sending.');
        return { ...result, held: activeCampaigns.length };
      }
      const syncStatus = new Map();
      for (const accountId of new Set([...activeCampaigns.map((r) => r.account_id), ...enabledAccounts])) {
        try { const synced = await inbox.sync(accountId); syncStatus.set(accountId, !synced.more); result.synced += synced.synced; }
        catch { syncStatus.set(accountId, false); }
      }
      for (const r of activeCampaigns) {
        if (row(r.id).status !== 'active') continue;
        if (!db.prepare("SELECT 1 FROM email_campaign_recipients WHERE campaign_id=? AND status='pending' LIMIT 1").get(r.id)) {
          db.prepare("UPDATE email_campaigns SET status='completed',hold_reason=NULL,updated_at=? WHERE id=?").run(now(), r.id); continue;
        }
        const c = json(r.config_json); const approval = json(r.approved_json);
        if (!accountIds().includes(c.accountId)) { db.prepare("UPDATE email_campaigns SET status='paused',hold_reason=? WHERE id=?").run('The sender was removed. Cancel this campaign and choose an available account.', r.id); continue; }
        const sender = service.forAccount(c.accountId);
        if (!syncStatus.get(c.accountId)) { hold(r.id, 'Waiting for a complete, successful inbox sync before sending.'); result.held++; continue; }
        if (!approval?.approved || sender.getSettings().revision !== approval.accountRevision || getEmailPolicy().revision !== approval.policyRevision) { db.prepare("UPDATE email_campaigns SET status='paused',hold_reason=? WHERE id=?").run('The sender or sending rules changed. Review the campaign again.', r.id); continue; }
        const due = db.prepare("SELECT * FROM email_campaign_recipients WHERE campaign_id=? AND status='pending' AND next_run_at<=? ORDER BY next_run_at LIMIT 1").get(r.id, now());
        if (!due) continue;
        const windowAt = nextSendWindow(now(), c.timezone, c.sendWindow);
        if (windowAt > now()) { db.prepare('UPDATE email_campaign_recipients SET next_run_at=? WHERE campaign_id=? AND to_email=?').run(windowAt, r.id, due.to_email); hold(r.id, 'Waiting for the campaign’s configured sending window.'); continue; }
        try { assertRecipientAllowed(due.to_email); } catch { stopRecipientSequences(due.to_email, 'suppressed'); continue; }
        const policy = getPolicyStatus();
        if (policy.paused || policy.usage.nextAllowedAt > now()) { hold(r.id, policy.paused ? 'Sending is paused in email settings.' : 'Waiting for the next allowed sending slot.'); continue; }
        const prepared = approval.messages.find((m) => m.to.toLowerCase() === due.to_email && m.stepIndex === due.next_step);
        if (!prepared) { hold(r.id, 'A reviewed message is missing. Pause and review the campaign.'); continue; }
        const key = `campaign:${r.id}:${digest(due.to_email).slice(0, 16)}:${due.next_step}:${due.attempt}`;
        try {
          const authorized = sender.authorizeScheduled(prepared, approval.accountRevision);
          // Recheck after asynchronous inbox/relay work: a pause or opt-out must win.
          if (row(r.id).status !== 'active' || db.prepare('SELECT status FROM email_campaign_recipients WHERE campaign_id=? AND to_email=?').get(r.id, due.to_email)?.status !== 'pending') continue;
          const sent = await sender.sendEmail({ ...authorized, idempotencyKey: key, confirmed: true }, { beforeSubmit: () => {
            if (row(r.id).status !== 'active' || db.prepare('SELECT status FROM email_campaign_recipients WHERE campaign_id=? AND to_email=?').get(r.id, due.to_email)?.status !== 'pending') throw emailError(409, 'CAMPAIGN_PAUSED', 'This campaign was paused or this recipient was stopped before submission.');
          } });
          const m = sent.message;
          if (m.status === 'sent') {
            const nextStep = due.next_step + 1; const finished = nextStep >= c.steps.length;
            db.prepare(`UPDATE email_campaign_recipients SET next_step=?,status=?,next_run_at=?,last_message_id=? WHERE campaign_id=? AND to_email=? AND status='pending'`)
              .run(nextStep, finished ? 'sent' : 'pending', finished ? now() : nextSendWindow((m.acceptedAt || now()) + c.steps[nextStep].delayHours * 3600000, c.timezone, c.sendWindow), m.id, r.id, due.to_email);
            result.sent++; hold(r.id, null);
          } else if (m.status !== 'sending') db.prepare("UPDATE email_campaign_recipients SET status=?,stop_reason=?,last_message_id=? WHERE campaign_id=? AND to_email=? AND status='pending'").run(m.status, m.errorCode, m.id, r.id, due.to_email);
        } catch (e) {
          // A pause before submission is known not to have sent. A later explicit resume
          // receives a new attempt key; uncertain provider outcomes are never retried.
          if (['CAMPAIGN_PAUSED', 'SEND_LIMIT', 'SENDING_PAUSED'].includes(e.code)) db.prepare('UPDATE email_campaign_recipients SET attempt=attempt+1 WHERE campaign_id=? AND to_email=?').run(r.id, due.to_email);
          hold(r.id, e.status ? e.message : 'A scheduled send could not be completed. Review message history.');
        }
        const remaining = db.prepare("SELECT count(*) n FROM email_campaign_recipients WHERE campaign_id=? AND status='pending'").get(r.id).n;
        if (!remaining) db.prepare("UPDATE email_campaigns SET status='completed',updated_at=? WHERE id=? AND status='active'").run(now(), r.id);
      }
      return result;
    } finally { ticking = false; }
  }
  function startWorker() { if (timer) return; timer = setInterval(() => { tick().catch(() => {}); }, 60000); timer.unref(); }
  function stopWorker() { clearInterval(timer); timer = null; }
  return { list, detail, create, update, review, start, action, tick, startWorker, stopWorker };
}
export const campaignService = createCampaignService();
