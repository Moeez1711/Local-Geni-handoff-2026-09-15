import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, qs } from '../lib/api.js';
import { emailTime } from '../lib/email.js';
import { groupInboxThreads, INBOX_KIND_LABELS } from '../lib/emailWorkflows.js';
import { Icon, PageHead } from './ui.jsx';

const noop = () => {};
const accountInbox = (account = {}) => account.inbox || {};
const inboundForm = (account = {}) => {
  const inbox = accountInbox(account);
  return { enabled: Boolean(inbox.enabled), host: inbox.host || (account.provider === 'gmail' ? 'imap.gmail.com' : ''), port: 993, username: inbox.username || account.fromEmail || '' };
};

export function IncomingMailSettings({ accountId, account = {}, notify = noop, onChanged, onDirtyChange, onBusyChange }) {
  const [form, setForm] = useState(() => inboundForm(account));
  const [saved, setSaved] = useState(() => inboundForm(account));
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const dirty = Boolean(password) || JSON.stringify(form) !== JSON.stringify(saved);
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  useEffect(() => { if (!dirtyRef.current) { const next = inboundForm(account); setForm(next); setSaved(next); } }, [account]);
  useEffect(() => { onDirtyChange?.(dirty || Boolean(busy)); }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const inbox = accountInbox(account);
  const microsoft = account.provider === 'microsoft';
  async function save(event) {
    event.preventDefault(); if (busy) return;
    setBusy('save'); setError(''); setResult('');
    try {
      await api.put(`/email/accounts/${encodeURIComponent(accountId)}/inbox`, { ...form, ...(password ? { password } : {}) });
      setSaved(form); setPassword(''); await onChanged?.();
      setResult('Saved. Verify before syncing.');
    } catch (err) { setError(err.message); } finally { setBusy(''); }
  }
  async function verify() {
    if (busy || dirty) return; setBusy('verify'); setError(''); setResult('');
    try {
      await api.post(`/email/accounts/${encodeURIComponent(accountId)}/inbox/verify`);
      await onChanged?.(); setResult('Incoming connection verified'); notify('Incoming connection verified', 'success');
    } catch (err) { setError(err.message); } finally { setBusy(''); }
  }
  return <section className="card form incoming-mail-settings" aria-labelledby="incoming-mail-heading">
    <div className="card-head"><div><h3 id="incoming-mail-heading">Incoming mail</h3></div><span className="chip">{inbox.verified ? 'Connection verified' : inbox.enabled ? 'Needs verification' : 'Not enabled'}</span></div>
    {error && <p className="email-status-note bad" role="alert">{error}</p>}
    {result && <p className="email-status-note" role="status">{result}</p>}
    <form onSubmit={save} className="form"><fieldset disabled={Boolean(busy) || !account.configured} className="form">
      <label className="workflow-check"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /><span>Check this mailbox for replies</span></label>
      {microsoft ? <p className="hint">Uses your Microsoft account. Reconnect to grant mail-reading permission.</p> : <>
        <div className="field-row"><label className="field grow"><span>Incoming mail server</span><input required={form.enabled} maxLength={253} placeholder="imap.your-provider.com" value={form.host} onChange={(event) => setForm({ ...form, host: event.target.value })} /></label><div className="field"><span>Secure port</span><p className="email-readonly-value">993 / TLS</p></div></div>
        <label className="field"><span>Incoming username</span><input required={form.enabled} maxLength={254} autoComplete="username" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="Usually your email address" /></label>
        <label className="field"><span>Incoming password or app password</span><input type="password" maxLength={512} autoComplete="new-password" required={form.enabled && account.provider === 'smtp' && !inbox.configured} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={inbox.configured || inbox.hasSecret ? 'Leave blank to keep the saved password' : account.provider === 'gmail' ? 'Leave blank to use your Google app password' : 'Enter your IMAP password'} /></label>
        <p className="hint">Plain text only. Remote images and attachments stay unloaded.</p>
      </>}
      <div className="preview-actions"><button className="btn primary" type="submit" disabled={!dirty && (!inbox.enabled || inbox.verified)}>{busy === 'save' ? 'Saving...' : 'Save'}</button><button className="btn" type="button" disabled={dirty || !inbox.enabled} onClick={verify}>{busy === 'verify' ? 'Verifying...' : 'Verify'}</button></div>
    </fieldset></form>
    {!account.configured && <p className="hint">Connect a sender first</p>}
    {inbox.lastSyncAt && <p className="hint">Last checked {emailTime(inbox.lastSyncAt)}</p>}
    {inbox.lastError && <p className="hint bad">Last check: {inbox.lastError}</p>}
  </section>;
}

export default function InboxWorkspace({ accountId, account, notify = noop, onComposeEmail, onOpenLead, onOpenSettings }) {
  const [rows, setRows] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [lastSync, setLastSync] = useState(null);
  const [syncNote, setSyncNote] = useState('');
  const alive = useRef(true);
  const lock = useRef(false);
  const load = useCallback(async () => {
    if (!accountId) { setRows([]); setLoading(false); return; }
    setLoading(true); setError('');
    try { const data = await api.get(`/email/inbox${qs({ accountId })}`); if (alive.current) { const sender = data.accounts?.find((item) => String(item.id) === String(accountId)); setRows(data.rows || []); setLastSync(sender?.lastSyncAt || sender?.inbox?.lastSyncAt || null); } }
    catch (err) { if (alive.current) setError(err.message); } finally { if (alive.current) setLoading(false); }
  }, [accountId]);
  useEffect(() => { alive.current = true; setSelectedId(''); load(); return () => { alive.current = false; }; }, [load]);
  const threads = useMemo(() => groupInboxThreads(rows), [rows]);
  const filtered = threads.filter((thread) => (kind === 'all' || thread.messages.some((message) => message.kind === kind)) && thread.messages.some((message) => `${message.fromEmail} ${message.fromName || ''} ${message.subject} ${message.text}`.toLowerCase().includes(query.toLowerCase())));
  const selected = threads.find((thread) => thread.id === selectedId);
  async function sync() {
    if (lock.current || !accountId) return; lock.current = true; setBusy('sync'); setError('');
    try { const result = await api.post('/email/inbox/sync', { accountId }); await load(); setSyncNote(result.more ? 'More messages remain. Check for replies again to continue.' : 'Recent inbox messages checked.'); notify(result.more ? 'Messages loaded. More remain to check.' : 'Mailbox checked', 'success'); }
    catch (err) { if (alive.current) setError(err.message); } finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  async function classify(message, nextKind) {
    if (lock.current) return; lock.current = true; setBusy(message.id); setError('');
    try { await api.post(`/email/inbox/${encodeURIComponent(message.id)}/classify`, { kind: nextKind }); await load(); notify(nextKind === 'ignore' ? 'Message marked as ignored' : message.placeId ? 'Message updated. Matching follow-ups stopped.' : 'Message type updated', 'success'); }
    catch (err) { if (alive.current) setError(err.message); } finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  async function reply(message) {
    if (lock.current || !message.placeId) return; lock.current = true; setBusy('reply'); setError('');
    try {
      const data = await api.get(`/leads/${encodeURIComponent(message.placeId)}`);
      const lead = data.lead || data;
      onComposeEmail?.({ ...lead, place_id: message.placeId, emails: [message.fromEmail] }, '', /^re:/i.test(message.subject || '') ? message.subject : `Re: ${message.subject || 'Your message'}`, load, { accountId: message.accountId, inReplyTo: message.messageId, references: [...new Set([...(message.references || []), message.messageId])].filter(Boolean).slice(-20) });
    } catch (err) { if (alive.current) setError(err.message); } finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  return <div className="page email-inbox-page">
    <PageHead eyebrow="Local Geni / Email" title="Inbox" ><button className="btn primary" disabled={Boolean(busy) || !account?.inbox?.verified} onClick={sync}><Icon name="search" />{busy === 'sync' ? 'Checking...' : 'Sync'}</button></PageHead>
    {error && <div className="email-status-note bad" role="alert"><p>{error}</p><button className="btn xs" disabled={Boolean(busy)} onClick={load}>Try again</button></div>}
    {syncNote && <p className="hint" role="status">{syncNote}</p>}
    {!account?.inbox?.verified && <section className="email-status-note"><Icon name="message" /><div><strong>{account?.inbox?.enabled ? 'Verify incoming mail' : 'Connect incoming mail'}</strong><p>Enable and verify replies for a mailbox to see conversations here and stop matching follow-ups.</p><button className="btn xs mt-3" onClick={onOpenSettings}>Set up mailbox</button></div></section>}
    <div className="workflow-toolbar"><label className="field grow"><span>Search conversations</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, email, subject or message" /></label><label className="field"><span>Show</span><select value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">All conversations</option>{Object.entries(INBOX_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    <p className="hint">{lastSync || account?.inbox?.lastSyncAt ? `Last checked ${emailTime(lastSync || account.inbox.lastSyncAt)}. ` : ''}Replies and bounces stop matching sequences after they are found. Incoming messages are shown as plain text.</p>
    {loading ? <section className="card" role="status">Loading conversations...</section> : <div className="inbox-layout">
      <aside className="card inbox-list" aria-label="Conversations">{filtered.length ? filtered.map((thread) => <button key={thread.id} type="button" className={`inbox-thread ${thread.id === selectedId ? 'active' : ''}`} aria-pressed={thread.id === selectedId} onClick={() => setSelectedId(thread.id)}><span className="inbox-thread-top"><strong>{thread.latest.fromName || thread.latest.fromEmail || 'Unknown sender'}</strong><small>{thread.messages.length}</small></span><span>{thread.latest.subject || 'No subject'}</span><small>{emailTime(thread.latest.receivedAt)}</small><span className={`email-status-badge email-status-${thread.latest.kind}`}>{INBOX_KIND_LABELS[thread.latest.kind] || 'Needs review'}</span></button>) : <div className="workflow-empty"><Icon name="message" /><h3>{query || kind !== 'all' ? 'No matching conversations' : 'No conversations'}</h3></div>}</aside>
      <section className="card inbox-conversation" aria-label="Selected conversation">{selected ? <><div className="card-head"><div><h3>{selected.latest.subject || 'Conversation'}</h3><p className="hint">{selected.messages.length} incoming {selected.messages.length === 1 ? 'message' : 'messages'}</p></div>{selected.placeId && onOpenLead && <button className="btn xs" onClick={() => onOpenLead(selected.placeId)}>Open business</button>}</div><ol className="inbox-messages">{selected.messages.map((message) => <li key={message.id}><header><div><strong>{message.fromName || message.fromEmail}</strong><p>{message.fromName ? message.fromEmail : ''}</p><time dateTime={new Date(message.receivedAt).toISOString()}>{emailTime(message.receivedAt)}</time></div><span className={`email-status-badge email-status-${message.kind}`}>{INBOX_KIND_LABELS[message.kind] || 'Needs review'}</span></header><pre className="email-review-message">{message.text || 'No plain-text message available.'}</pre><div className="inbox-message-actions"><label className="field"><span>Message type</span><select aria-label={`Message type for ${message.subject || 'message'}`} disabled={Boolean(busy)} value={message.kind || 'unknown'} onChange={(event) => classify(message, event.target.value)}>{['unknown', 'unmatched', 'automated'].includes(message.kind || 'unknown') && <option value={message.kind || 'unknown'} disabled>{INBOX_KIND_LABELS[message.kind] || 'Needs review'}</option>}{Object.entries(INBOX_KIND_LABELS).filter(([value]) => ['reply', 'bounce', 'opt_out', 'ignore'].includes(value)).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="btn" disabled={Boolean(busy) || !message.placeId || !message.messageId || message.kind !== 'reply' || !onComposeEmail} onClick={() => reply(message)}>Reply</button></div>{!message.placeId && <p className="hint">This message could not be linked to a saved business.</p>}</li>)}</ol></> : <div className="workflow-empty"><Icon name="message" /><h3>Choose a conversation</h3></div>}</section>
    </div>}
  </div>;
}
