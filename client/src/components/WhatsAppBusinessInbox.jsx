import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { whatsappTime } from '../lib/whatsappApi.js';
import { useWorkspaceAccess } from './AuthWorkspace.jsx';
import { Icon } from './ui.jsx';
import '../whatsapp-business-inbox.css';

export default function WhatsAppBusinessInbox({ onOpenConnection, onOpenTemplates, onDirtyChange, onBusyChange }) {
  const access = useWorkspaceAccess();
  const canManage = !access?.configured || access?.permissions?.includes('manageConnections');
  const canSend = !access?.configured || access?.permissions?.includes('outreach');
  const [settings, setSettings] = useState(null);
  const [threads, setThreads] = useState([]);
  const [selected, setSelected] = useState('');
  const [conversation, setConversation] = useState(null);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [secrets, setSecrets] = useState({ appSecret: '', verifyToken: '' });
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showSetup, setShowSetup] = useState(false);
  const alive = useRef(false);
  const lock = useRef(false);
  const sendKey = useRef(null);
  const scroll = useRef(null);
  const dirty = Boolean(draft || secrets.appSecret || secrets.verifyToken);

  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    const unload = event => { if (dirty || lock.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [dirty]);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    api.get('/whatsapp/inbox/threads', { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setSettings(result); setThreads(result.rows || []);
    }).catch(err => { if (!controller.signal.aborted) setError(err.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { alive.current = false; controller.abort(); };
  }, []);
  useEffect(() => {
    if (!selected) { setConversation(null); return undefined; }
    const controller = new AbortController();
    let running = false;
    async function refresh() {
      if (running || lock.current || document.hidden) return;
      running = true;
      try {
        const result = await api.get(`/whatsapp/inbox/messages?number=${encodeURIComponent(selected)}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setConversation(result); setError(''); }
      } catch (err) { if (!controller.signal.aborted) { setConversation(null); setError(err.message); } }
      finally { running = false; }
    }
    setConversation(null);
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [selected]);
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    const timer = setInterval(async () => {
      if (lock.current || running || document.hidden) return;
      running = true;
      try { const result = await api.get('/whatsapp/inbox/threads', { signal: controller.signal }); if (!controller.signal.aborted) { setThreads(result.rows || []); setSettings(result); } }
      catch (err) { if (!controller.signal.aborted) setError(`Inbox refresh failed: ${err.message}`); }
      finally { running = false; }
    }, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  useEffect(() => { scroll.current?.scrollIntoView({ block: 'nearest' }); }, [selected, conversation?.rows?.at(-1)?.id]);

  function select(number) {
    if (lock.current || number === selected) return;
    if (draft && !window.confirm('Discard this unsent reply before switching conversations?')) return;
    setDraft(''); sendKey.current = null; setSelected(number); setError(''); setNotice('');
  }
  async function saveWebhook(event) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true; setBusy('settings'); setError(''); setNotice('');
    try {
      const result = await api.put('/whatsapp/inbox/settings', { ...secrets, accountRevision: settings.accountRevision });
      if (alive.current) { setSettings(result); setSecrets({ appSecret: '', verifyToken: '' }); setNotice('Webhook settings saved'); }
    } catch (err) { if (alive.current) setError(err.message); }
    finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  async function send(event) {
    event.preventDefault();
    if (lock.current || !canSend || !conversation?.canReply || !draft.trim()) return;
    lock.current = true; setBusy('reply'); setError(''); setNotice('');
    const context = { number: selected, text: draft.trim(), inReplyTo: conversation.inReplyTo, accountRevision: conversation.accountRevision };
    const signature = JSON.stringify(context);
    if (sendKey.current?.signature !== signature) sendKey.current = { signature, value: crypto.randomUUID() };
    try {
      const result = await api.post('/whatsapp/inbox/reply', { ...context, idempotencyKey: sendKey.current.value });
      if (!alive.current) return;
      setConversation(current => current ? { ...current, rows: [...current.rows.filter(row => row.id !== result.message.id), result.message] } : current);
      if (result.message.status === 'accepted') { setDraft(''); sendKey.current = null; setNotice(result.duplicate ? 'Already submitted. Not resent.' : 'Meta accepted reply'); }
      else { setError(result.message.error || 'This reply is still being submitted. Refresh the conversation before sending again.'); }
    } catch (err) { if (alive.current) setError(`${err.message} Duplicate protection remains active.`); }
    finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  const activeThread = threads.find(thread => thread.number === selected);
  const visibleThreads = threads.filter(thread => `${thread.businessName || ''} ${thread.profileName || ''} ${thread.number} ${thread.lastText || ''}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="wa-business-inbox">
    <header className="wa-business-head"><div /><div className="preview-actions"><button className="btn" disabled={Boolean(busy)} onClick={onOpenConnection}>Connection</button><button className="btn" disabled={Boolean(busy)} aria-expanded={showSetup} onClick={() => { if (showSetup && (secrets.appSecret || secrets.verifyToken)) return; setShowSetup(value => !value); }}>Webhook</button></div></header>
    {error && <p className="whatsapp-batch-error" role="alert">{error}</p>}
    {notice && <p className="wa-business-notice" role="status">{notice}</p>}
    {loading && <p className="hint" role="status">Loading business inbox...</p>}
    {!loading && !settings && <p className="wa-business-notice">Inbox unavailable. Restart Local Geni.</p>}
    {settings && !settings.verified && <p className="wa-business-notice">Verify your connection to reply</p>}
    {settings?.paused && <p className="wa-business-notice">Sending paused. Incoming messages remain available.</p>}
    {showSetup && settings && <section className="card wa-business-setup"><div><h3>Webhook</h3><p className="hint">{settings.lastWebhookAt ? `Last event ${whatsappTime(settings.lastWebhookAt)}` : settings.webhookConfigured ? 'Waiting for events' : 'Not connected'}</p><details className="integration-help"><summary>Setup guide</summary><div className="form mt-3"><p>Forward only <code>{settings.webhookPath}</code> through public HTTPS.</p><p>Never expose the entire CRM. Localhost cannot receive Meta events.</p><p>Set the callback and matching verify token in Meta.</p><p>Subscribe your business account. Enable the <code>messages</code> field.</p><p>New messages only. Personal chat history is not imported.</p></div></details></div>{canManage ? <form className="form" onSubmit={saveWebhook}><label className="field"><span>App secret</span><input type="password" autoComplete="new-password" minLength={16} maxLength={1024} required={!settings.hasAppSecret} value={secrets.appSecret} onChange={event => setSecrets(current => ({ ...current, appSecret: event.target.value }))} placeholder={settings.hasAppSecret ? 'Saved secret' : 'From Meta'} disabled={Boolean(busy)} /></label><label className="field"><span>Verify token</span><input type="password" autoComplete="new-password" minLength={16} maxLength={1024} required={!settings.hasVerifyToken} value={secrets.verifyToken} onChange={event => setSecrets(current => ({ ...current, verifyToken: event.target.value }))} placeholder="Match the token in Meta" disabled={Boolean(busy)} /></label><p className="hint">Leave saved secrets blank to keep them</p><button className="btn primary" disabled={Boolean(busy) || !settings.configured || (!secrets.appSecret && !secrets.verifyToken)}>{busy === 'settings' ? 'Saving...' : 'Save'}</button></form> : <p className="hint">Ask an admin to connect</p>}</section>}
    <div className={`wa-business-layout ${selected ? 'has-conversation' : ''}`}>
      <aside className="wa-business-threads" aria-label="Business conversations"><label className="field"><span>Conversations</span><input type="search" placeholder="Search conversations" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="wa-business-thread-list">{visibleThreads.map(thread => <button type="button" key={thread.number} className={selected === thread.number ? 'active' : ''} disabled={Boolean(busy)} onClick={() => select(thread.number)} aria-pressed={selected === thread.number}><span className="wa-business-avatar">{(thread.businessName || thread.profileName || '#').slice(0, 1).toUpperCase()}</span><span><strong>{thread.businessName || thread.profileName || `+${thread.number}`}</strong><small>{thread.direction === 'outbound' ? 'You: ' : ''}{thread.lastText || `[${thread.lastType || 'Attachment'}]`}</small><time>{whatsappTime(thread.lastMessageAt)}</time></span></button>)}{!visibleThreads.length && <div className="wa-business-empty"><Icon name="message" /><strong>{query ? 'No matching conversations' : 'No conversations'}</strong>{query && <button className="btn ghost" onClick={() => setQuery('')}>Clear search</button>}</div>}</div></aside>
      <div className="wa-business-conversation">{selected ? <><header><button className="btn ghost wa-business-back" disabled={Boolean(busy)} onClick={() => select('')}>Back</button><div><h3>{activeThread?.businessName || activeThread?.profileName || `+${selected}`}</h3><p className="hint">+{selected}{conversation?.placeId ? ' / CRM linked' : ' / Not linked'}</p></div><span className="whatsapp-status">{conversation?.canReply ? 'Replies open' : 'Replies closed'}</span></header><div className="wa-business-messages" role="log" aria-label="Conversation messages" aria-live="polite">{!conversation && <p className="hint">Loading conversation...</p>}{conversation?.rows.map(message => <article key={message.id} className={`wa-business-message ${message.direction}`}><p>{message.text || `[${message.type} attachment]`}</p>{message.media && <small>{message.media.filename || message.type} / Preview unavailable</small>}<footer><time>{whatsappTime(message.receivedAt)}</time>{message.direction === 'outbound' && <span>{message.deliveryStatus || message.status}</span>}</footer>{message.error && <small className="bad">{message.error}</small>}</article>)}<div ref={scroll} /></div><form className="wa-business-composer" onSubmit={send}><label className="field"><span>Reply</span><textarea maxLength={4096} value={draft} disabled={Boolean(busy) || !canSend} onChange={event => setDraft(event.target.value)} aria-label={`Reply to +${selected}`} placeholder="Write a reply" /></label><div><p className="hint">{conversation?.replyWindowEndsAt ? `Window ends ${whatsappTime(conversation.replyWindowEndsAt)}` : 'No reply window'}</p><button className="btn primary" disabled={Boolean(busy) || !canSend || !conversation?.canReply || !draft.trim()}>{busy === 'reply' ? 'Sending...' : 'Send reply'}</button></div>{!conversation?.canReply && <button type="button" className="btn ghost" disabled={Boolean(busy)} onClick={onOpenTemplates}>Use a template</button>}</form></> : <div className="wa-business-empty"><Icon name="message" />{settings && !settings.verified ? <><h3>Connect your business number</h3><button className="btn" onClick={onOpenConnection}>Connect</button></> : <h3>Choose a conversation</h3>}</div>}</div>
    </div>
  </section>;
}
