import { useCallback, useEffect, useRef, useState } from 'react';
import { api, qs } from '../lib/api.js';
import { EMAIL_PROVIDERS, isSingleEmail, microsoftVerificationUrl } from '../lib/email.js';
import { Icon } from './ui.jsx';
import ProviderIcon from './ProviderIcon.jsx';

const formFor = (settings = {}) => ({
  provider: settings.provider || 'gmail', fromName: settings.fromName || '', fromEmail: settings.fromEmail || '',
  replyTo: settings.replyTo || '', host: settings.host || '', port: settings.port || 465,
  username: settings.username || '', clientId: settings.clientId || '', tenant: settings.tenant || 'common',
});
const noop = () => {};

export default function EmailSettings({ accountId, notify = noop, onChanged, onDirtyChange, onBusyChange, children, initialProvider = '' }) {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(formFor());
  const [saved, setSaved] = useState(formFor());
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const [session, setSession] = useState(null);
  const [authStatus, setAuthStatus] = useState('');
  const [allowInbox, setAllowInbox] = useState(false);
  const formRef = useRef(null);
  const mounted = useRef(true);
  const callbacks = useRef({ notify, onChanged });
  callbacks.current = { notify, onChanged };
  const guardRef = useRef(false);
  const dirty = Boolean(password) || JSON.stringify(form) !== JSON.stringify(saved);
  guardRef.current = dirty || Boolean(busy) || Boolean(session);

  function receive(next) {
    setSettings(next); const normalized = formFor(next);
    if (initialProvider && !next.configured && !next.fromEmail && !next.host) normalized.provider = initialProvider;
    setForm(normalized); setSaved(normalized); setPassword('');
  }
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { const next = await api.get(`/email/settings${qs({ accountId })}`); if (mounted.current) receive(next); }
    catch (err) { if (mounted.current) setError(err.message); }
    finally { if (mounted.current) setLoading(false); }
  }, [accountId]);
  useEffect(() => { mounted.current = true; load(); return () => { mounted.current = false; }; }, [load]);
  useEffect(() => { onDirtyChange?.(guardRef.current); }, [dirty, busy, session, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    const guard = (event) => { if (guardRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);

  useEffect(() => {
    if (!session) return undefined;
    let off = false;
    let timer;
    let interval = Math.max(5, Number(session.interval) || 5) * 1000;
    const expiresAt = Number(session.expiresAt) || new Date(session.expiresAt).getTime() || Date.now() + 15 * 60 * 1000;
    const poll = async () => {
      if (off) return;
      if (Date.now() >= expiresAt) { setSession(null); setAuthStatus('This sign-in code expired. Start again for a fresh code.'); return; }
      try {
        const result = await api.post(`/email/microsoft/poll${qs({ accountId })}`);
        if (off) return;
        if (result.status === 'connected') {
          const next = result.settings || await api.get(`/email/settings${qs({ accountId })}`);
          if (off) return;
          receive(next); setSession(null); setAuthStatus('Microsoft account connected.'); callbacks.current.onChanged?.(next); callbacks.current.notify('Microsoft account connected', 'success'); return;
        }
        if (result.status === 'expired') { setSession(null); setAuthStatus('This sign-in code expired. Start again for a fresh code.'); return; }
        if (result.interval) interval = Math.max(interval, Number(result.interval) * 1000);
        setAuthStatus('Waiting for sign-in...');
      } catch (err) {
        if (off) return;
        if (err.code === 'slow_down') interval += 5000;
        else if (['authorization_declined', 'access_denied', 'expired_token'].includes(err.code)) { setSession(null); setAuthStatus(err.message); return; }
        else { interval = Math.min(interval * 2, 30000); setAuthStatus('Connection check paused briefly. We will check again while this code is valid.'); }
      }
      timer = setTimeout(poll, interval);
    };
    timer = setTimeout(poll, interval);
    return () => { off = true; clearTimeout(timer); };
  }, [session, accountId]);

  const setField = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  function chooseProvider(provider) {
    if (busy || session || provider === form.provider) return;
    if (dirty && !window.confirm('Discard your unsaved email settings and change provider?')) return;
    setPassword(''); setError(''); setAuthStatus('');
    setForm(provider === saved.provider ? saved : { ...formFor(), provider, fromName: saved.fromName, replyTo: saved.replyTo });
  }
  function validate() {
    if (!formRef.current?.reportValidity()) return false;
    if (form.provider !== 'microsoft' && !isSingleEmail(form.fromEmail.trim())) { setError('Enter one complete sender email address.'); return false; }
    if (form.replyTo && !isSingleEmail(form.replyTo.trim())) { setError('Enter one complete reply-to email address.'); return false; }
    return true;
  }
  async function save(event) {
    event?.preventDefault();
    if (busy || session || !validate()) return;
    setBusy('save'); setError('');
    try {
      const next = await api.put(`/email/settings${qs({ accountId })}`, { ...form, fromEmail: form.fromEmail.trim(), replyTo: form.replyTo.trim(), port: Number(form.port), ...(password ? { password } : {}) });
      receive(next); onChanged?.(next); notify('Saved. Verify before sending.', 'success');
    } catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }
  async function verify() {
    if (dirty || busy) return;
    setBusy('verify'); setError('');
    try { const next = await api.post(`/email/verify${qs({ accountId })}`); receive(next); onChanged?.(next); notify('Email connection verified', 'success'); }
    catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }
  async function beginMicrosoft() {
    if (busy || !validate()) return;
    setBusy('microsoft'); setError(''); setAuthStatus('');
    try {
      if (dirty) {
        const next = await api.put(`/email/settings${qs({ accountId })}`, { ...form, port: Number(form.port) });
        receive(next); onChanged?.(next);
      }
      const next = await api.post(`/email/microsoft/start${qs({ accountId })}`, { clientId: form.clientId.trim(), tenant: form.tenant.trim() || 'common', inbox: allowInbox });
      if (!microsoftVerificationUrl(next.verificationUri)) throw new Error('Microsoft returned an unexpected sign-in address. Please start again.');
      setSession(next); setAuthStatus('Enter this code on Microsoft to sign in');
    } catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }
  async function cancelMicrosoft() {
    setBusy('cancel');
    try { await api.post(`/email/microsoft/cancel${qs({ accountId })}`); setSession(null); setAuthStatus('Sign-in canceled.'); }
    catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }
  async function disconnect() {
    if (!window.confirm('Disconnect this email account from Local Geni? Saved message history will remain.')) return;
    setBusy('disconnect'); setError('');
    try { const next = await api.del(`/email/connection${qs({ accountId })}`); setSession(null); receive(next || await api.get(`/email/settings${qs({ accountId })}`)); onChanged?.(next); notify('Email account disconnected', 'success'); }
    catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }
  async function copyCode() {
    try { await navigator.clipboard.writeText(session.userCode); notify('Microsoft sign-in code copied', 'success'); }
    catch { setAuthStatus('Select the code above and copy it manually.'); }
  }

  const connectionLabel = dirty ? 'Unsaved changes' : settings?.verified ? 'Verified' : settings?.configured ? 'Verify' : 'Not connected';
  const locked = Boolean(busy) || Boolean(session);
  const secretKept = settings?.hasSecret && form.provider === settings.provider
    && form.fromEmail.trim().toLowerCase() === (settings.fromEmail || '').toLowerCase()
    && (form.provider !== 'smtp' || (form.host.trim().toLowerCase() === (settings.host || '').toLowerCase()
      && Number(form.port) === Number(settings.port) && form.username.trim() === (settings.username || '')));

  return <div className="page email-settings-page">
    {loading ? <section className="card" role="status">Loading email settings...</section> : <>
      {error && <div className="email-status-note bad" role="alert"><Icon name="alert" /><p>{error}</p>{!settings && <button className="btn xs" onClick={load}>Try again</button>}</div>}
      {settings && <div className="email-settings-grid">
        <section className="card form">
          <div className="card-head"><h3>Connection</h3><span className={`chip email-connection-status ${settings.verified && !dirty ? 'verified' : ''}`}>{connectionLabel}</span></div>
          {settings.connectedEmail && <p className="hint">Connected as <strong>{settings.connectedEmail}</strong></p>}
          <div className="seg wrap email-provider-tabs" role="group" aria-label="Email provider">{EMAIL_PROVIDERS.map(([key, label]) => <button type="button" disabled={locked} key={key} className={form.provider === key ? 'on' : ''} aria-label={label} title={label} aria-pressed={form.provider === key} onClick={() => chooseProvider(key)}><ProviderIcon provider={key} size={18} />{key === 'gmail' ? 'Gmail' : key === 'microsoft' ? 'Microsoft 365' : 'SMTP'}</button>)}</div>
          <form ref={formRef} onSubmit={save} className="form">
            <fieldset disabled={locked} className="form">
              <label className="field"><span>Sender name <em>optional</em></span><input maxLength={120} autoComplete="name" placeholder="Name" value={form.fromName} onChange={(event) => setField('fromName', event.target.value)} /></label>
              {form.provider !== 'microsoft' ? <label className="field"><span>Sender email</span><input required type="email" maxLength={254} autoComplete="email" placeholder="you@yourbusiness.com" value={form.fromEmail} onChange={(event) => setField('fromEmail', event.target.value)} /></label>
                : settings.provider === 'microsoft' && settings.connectedEmail ? <div className="field"><span>Microsoft mailbox</span><p className="email-readonly-value">{settings.connectedEmail}</p></div> : <p className="hint">Your Microsoft account supplies the sender address</p>}
              <label className="field"><span>Reply-to address <em>optional</em></span><input type="email" maxLength={254} placeholder="Same as sender" value={form.replyTo} onChange={(event) => setField('replyTo', event.target.value)} /></label>
              {form.provider === 'gmail' && <label className="field"><span>Google app password</span><input type="password" autoComplete="new-password" maxLength={512} required={!secretKept} value={password} placeholder={secretKept ? 'Saved password' : 'Google app password'} onChange={(event) => setPassword(event.target.value)} /><small className="hint">Use a Google app password, not your account password</small></label>}
              {form.provider === 'smtp' && <>
                <div className="field-row"><label className="field grow"><span>SMTP hostname</span><input required maxLength={253} autoComplete="off" placeholder="smtp.your-provider.com" value={form.host} onChange={(event) => setField('host', event.target.value)} /></label><label className="field"><span>Secure port</span><select value={form.port} onChange={(event) => setField('port', Number(event.target.value))}><option value={465}>465 / TLS</option><option value={587}>587 / STARTTLS</option></select></label></div>
                <label className="field"><span>SMTP username</span><input required maxLength={254} autoComplete="username" placeholder="Usually your email address" value={form.username} onChange={(event) => setField('username', event.target.value)} /></label>
                <label className="field"><span>Password</span><input type="password" maxLength={512} autoComplete="new-password" required={!secretKept} value={password} placeholder={secretKept ? 'Saved password' : 'SMTP password'} onChange={(event) => setPassword(event.target.value)} /></label>
              </>}
              {form.provider === 'microsoft' && <>
                <label className="field"><span>Application (client) ID</span><input required maxLength={100} autoComplete="off" placeholder="From your Microsoft app registration" value={form.clientId} onChange={(event) => setField('clientId', event.target.value)} /></label>
                <label className="field"><span>Microsoft tenant</span><input required maxLength={253} autoComplete="off" placeholder="common" value={form.tenant} onChange={(event) => setField('tenant', event.target.value)} /><small className="hint">Use common or your organization tenant ID</small></label>
                <label className="workflow-check"><input type="checkbox" checked={allowInbox} onChange={(event) => setAllowInbox(event.target.checked)} /><span>Read replies and bounces</span></label><p className="hint">Adds Mail.Read permission. Enable incoming mail after connecting.</p>
              </>}
            </fieldset>
            <div className="preview-actions">
              <button className="btn primary" type="submit" disabled={locked || !dirty}>{busy === 'save' ? 'Saving...' : 'Save'}</button>
              {form.provider === 'microsoft' && <button className="btn" type="button" disabled={locked} onClick={beginMicrosoft}>{busy === 'microsoft' ? 'Preparing sign-in...' : 'Sign in'}</button>}
              <button className="btn" type="button" disabled={locked || dirty || !settings.configured} onClick={verify}>{busy === 'verify' ? 'Checking connection...' : 'Verify'}</button>
              {settings.configured && <button className="btn ghost" type="button" disabled={locked} onClick={disconnect}>Disconnect</button>}
            </div>
            <p className="hint">Verification sends no email</p>
          </form>
          {session && <section className="email-device-code" aria-label="Microsoft sign-in code">
            <h3>Microsoft sign-in</h3><div className="email-device-code-value"><code>{session.userCode}</code><button className="btn xs" onClick={copyCode}>Copy code</button></div>
            <div className="preview-actions"><a className="btn primary" href={microsoftVerificationUrl(session.verificationUri)} target="_blank" rel="noreferrer">Open Microsoft</a><button className="btn" disabled={Boolean(busy)} onClick={cancelMicrosoft}>Cancel sign-in</button></div>
          </section>}
          {authStatus && <p className="hint" role="status">{authStatus}</p>}
        </section>
        <details className="card email-provider-help integration-help"><summary>Setup guide</summary><div className="form mt-3">
          <div className="card-head"><h3>{form.provider === 'gmail' ? 'Connect with Google' : form.provider === 'microsoft' ? 'Connect with Microsoft' : 'Use your email provider'}</h3><Icon name="lock" /></div>
          {form.provider === 'gmail' ? <><p>Turn on 2-Step Verification, then create a Google app password for Local Geni.</p><p>App passwords may be unavailable. Ask your Google Workspace admin.</p><a className="link" href="https://support.google.com/accounts/answer/185833" target="_blank" rel="noreferrer">Google’s app password instructions</a><a className="btn" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">Open Google app passwords</a></>
            : form.provider === 'microsoft' ? <><p>Register an app in Microsoft Entra. Choose the account types you need, then enable public client flows under Authentication.</p><p>Add Microsoft Graph delegated permissions for User.Read, Mail.Send and Mail.Read. Copy the Application (client) ID here. Sign in and approve access with the mailbox you want to use.</p><p>Mail.Read lets Local Geni find replies and bounces. Your organization may require administrator approval. A client secret is not needed for this sign-in flow.</p><a className="link" href="https://learn.microsoft.com/en-us/graph/auth-register-app-v2" target="_blank" rel="noreferrer">Microsoft’s app registration guide</a><a className="link" href="https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code" target="_blank" rel="noreferrer">How Microsoft’s device sign-in works</a></>
              : <><p>Use the secure SMTP settings supplied by your mailbox provider. The sender address must be an address that account is allowed to send from.</p><p>Port 465 uses TLS from the start. Port 587 upgrades to TLS before authentication.</p><p>If your provider requires an app password, use that password here.</p></>}
          <div className="email-status-note"><Icon name="message" /><p>Accepted does not mean delivered or read</p></div>
        </div></details>
      </div>}
      {children}
    </>}
  </div>;
}
