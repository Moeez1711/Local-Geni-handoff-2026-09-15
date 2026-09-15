import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from './ui.jsx';
import ProviderIcon from './ProviderIcon.jsx';
import { useSurfaceMotion } from './FluidMotion.jsx';
import '../assistant.css';

const names = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google Gemini' };
export default function AskGeni({ onOpenIntegrations, view, obscured = false, inToolbar = false }) {
  const [open, setOpen] = useState(false), [provider, setProvider] = useState('anthropic'), [connections, setConnections] = useState([]);
  const [models, setModels] = useState([]), [model, setModel] = useState(''), [messages, setMessages] = useState([]), [question, setQuestion] = useState('');
  const [includeTotals, setIncludeTotals] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [simulated, setSimulated] = useState(false);
  const launch = useRef(null), end = useRef(null), lock = useRef(false);
  const { ref: dialog } = useSurfaceMotion(open, { native: true, anchor: launch });
  const connected = connections.find(item => item.id === provider)?.verified;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    api.get('/assistant/connections', { signal: controller.signal }).then(data => { setConnections(data.rows); setSimulated(data.simulated); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [open]);
  useEffect(() => {
    setModels([]); setModel('');
    if (!connected || !open) return;
    const controller = new AbortController();
    api.get(`/assistant/models/${provider}`, { signal: controller.signal }).then(data => { setModels(data.rows); setModel(data.rows[0]?.id || ''); }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [provider, connected, open]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [messages, busy]);
  async function send(event) {
    event.preventDefault(); if (lock.current || !question.trim() || !model) return;
    const next = [...messages, { role: 'user', content: question.trim() }];
    lock.current = true; setBusy(true); setError('');
    try { const result = await api.post('/assistant/chat', { provider, model, messages: next.slice(-19), includeTotals }); setMessages([...next, { role: 'assistant', content: result.text }]); setQuestion(''); }
    catch (e) { setError(e.message); } finally { lock.current = false; setBusy(false); }
  }
  return <>
    <button ref={launch} className={`ask-geni-launch ${inToolbar ? 'in-toolbar' : ''}`} hidden={obscured} aria-label="Ask Geni" title="Ask Geni" onClick={() => setOpen(true)}><Icon name="sparkles" size={17}/><span>Ask Geni</span></button>
    <dialog ref={dialog} className="ask-geni-panel" aria-labelledby="ask-geni-title" onCancel={event => { event.preventDefault(); setOpen(false); }}>
      <header><div><Icon name="sparkles" size={20}/><h2 id="ask-geni-title">Ask Geni</h2><span>{view}</span></div><div><button className="ci" title="New chat" aria-label="New chat" disabled={busy} onClick={() => { setMessages([]); setQuestion(''); setError(''); }}><Icon name="plus" size={18}/></button><button className="ci" title="Close Ask Geni" aria-label="Close Ask Geni" onClick={() => setOpen(false)}><Icon name="close" size={18}/></button></div></header>
      <div className="ask-geni-controls"><div className="ask-geni-providers" role="group" aria-label="AI provider">{Object.entries(names).map(([id, name]) => <button key={id} type="button" className={`ci${provider === id ? ' selected' : ''}`} title={name} aria-label={name} aria-pressed={provider === id} disabled={busy} onClick={() => { if (provider !== id) { setProvider(id); setMessages([]); setError(''); } }}><ProviderIcon provider={id} size={19}/></button>)}</div>
        {connected && <label><span className="sr-only">AI model</span><select value={model} disabled={busy || !models.length} onChange={e => setModel(e.target.value)}>{!models.length && <option value="">Loading models…</option>}{models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        <button className="ci" title="AI connections" aria-label="Open AI integrations" onClick={() => { setOpen(false); onOpenIntegrations(); }}><Icon name="plug" size={17}/></button>
      </div>
      {!connected && <div className="ask-geni-connect"><ProviderIcon provider={provider} size={18}/><span>Connect {names[provider]} to start.</span><button className="btn" onClick={() => { setOpen(false); onOpenIntegrations(); }}>Connect</button></div>}
      {simulated && <p className="ask-geni-sample">Sample mode · AI responses are simulated</p>}
      <div className="ask-geni-messages" role="log" aria-live="polite">
        {!messages.length && <div className="ask-geni-empty"><Icon name="sparkles" size={32}/><h3>What would you like to work on?</h3><p>Questions, insights, and drafts. You make the changes.</p>{['Summarize my outreach progress', 'Draft a short follow-up SMS', 'Help me prioritize leads'].map(prompt => <button key={prompt} disabled={busy} onClick={() => setQuestion(prompt)}>{prompt}<Icon name="arrowUpRight" size={15}/></button>)}</div>}
        {messages.map((message, index) => <article key={index} className={message.role}><small>{message.role === 'user' ? 'You' : 'Geni'}</small><p>{message.content}</p></article>)}
        {busy && <p role="status">Thinking…</p>}<div ref={end}/>
      </div>
      {error && <p className="ask-geni-error" role="alert">{error}</p>}
      <form className="ask-geni-composer" onSubmit={send}><label className="system-auto-check"><input type="checkbox" checked={includeTotals} disabled={busy} onChange={e => setIncludeTotals(e.target.checked)}/><span>Include workspace totals</span></label>
        <div><textarea aria-label="Ask Geni a question" rows={2} value={question} maxLength={6000} onChange={e => setQuestion(e.target.value)} placeholder="Ask, or describe a draft…" disabled={busy}/><button className="btn primary" title="Send question" aria-label="Send question" disabled={busy || !connected || !model || !question.trim()}><Icon name="arrowUp" size={19}/></button></div><small>Sent to {names[provider]}. API usage is billed by your provider.</small>
      </form>
    </dialog>
  </>;
}
