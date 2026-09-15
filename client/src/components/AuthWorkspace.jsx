import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import BrandMark from './BrandMark.jsx';
import TeamWorkspace from './TeamWorkspace.jsx';
import { JoinWorkspace } from './TeamInvitation.jsx';
import { api } from '../lib/api.js';
import { Button, Field, Icon, PageHead } from './ui.jsx';

const AccessContext = createContext({ permissions: [], authenticated: false });
export const useWorkspaceAccess = () => useContext(AccessContext);
const changed = () => window.dispatchEvent(new Event('local-geni-auth-changed'));
export function AuthBoundary({ children }) {
  const [state, setState] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [identifier, setIdentifier] = useState(''), [password, setPassword] = useState('');
  const alive = useRef(true);
  const [inviteToken, setInviteToken] = useState(() => window.location.hash.startsWith('#join=') ? window.location.hash.slice(6) : '');
  const refresh = useCallback(async () => {
    try { const next = await api.get('/auth/status'); if (alive.current) { setState(next); setError(''); } }
    catch (err) { if (alive.current) { setState(null); setError(err.message); } }
  }, []);
  useEffect(() => {
    alive.current = true; refresh();
    window.addEventListener('local-geni-auth-changed', refresh);
    return () => { alive.current = false; window.removeEventListener('local-geni-auth-changed', refresh); };
  }, [refresh]);
  useEffect(() => { const handleHash = () => setInviteToken(window.location.hash.startsWith('#join=') ? window.location.hash.slice(6) : ''); window.addEventListener('hashchange', handleHash); return () => window.removeEventListener('hashchange', handleHash); }, []);
  if (inviteToken) return <JoinWorkspace token={inviteToken} onJoined={async () => { await refresh(); window.location.hash = 'home'; setInviteToken(''); }}/>;
  if (state?.authenticated) return <AccessContext.Provider value={state}>{children}</AccessContext.Provider>;
  return <main className="auth-shell"><section className="auth-card"><div className="auth-wordmark"><BrandMark size={36} />Local Geni</div><h1>{state ? 'Welcome back' : 'Opening your workspace'}</h1>
    {error && <p className="banner error" role="alert">{error}</p>}
    {state ? <form className="form" onSubmit={async event => {
      event.preventDefault(); if (busy) return; setBusy(true); setError('');
      try { await api.post('/auth/login', { identifier, password, remember: true }); setPassword(''); await refresh(); }
      catch (err) { setError(err.message); } finally { setBusy(false); }
    }}><Field id="auth-identifier" label="Name or email" required><input autoComplete="username" value={identifier} onChange={event => setIdentifier(event.target.value)} disabled={busy} /></Field><Field id="auth-password" label="Password" required><input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></Field><Button type="submit" variant="primary" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</Button></form> : error ? <Button onClick={refresh}>Try again</Button> : <p role="status">Connecting...</p>}
  </section></main>;
}
export default function PrivacyWorkspace({ notify, onDirtyChange, onBusyChange, initialSection = 'account' }) {
  const status = useWorkspaceAccess();
  const [section, setSection] = useState(initialSection), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [name, setName] = useState(status.user?.name || ''), [email, setEmail] = useState(status.email || '');
  const [password, setPassword] = useState(''), [confirm, setConfirm] = useState(''), [current, setCurrent] = useState('');
  const [teamDirty, setTeamDirty] = useState(false), [teamBusy, setTeamBusy] = useState(false);
  const lock = useRef(false), guard = useRef(false);
  const accountDirty = name !== (status.user?.name || '') || email !== (status.email || '') || Boolean(password || confirm || current);
  const dirty = accountDirty || teamDirty;
  guard.current = dirty || busy || teamBusy;
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy || teamBusy); return () => onBusyChange?.(false); }, [busy, teamBusy, onBusyChange]);
  useEffect(() => {
    const unload = event => { if (guard.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload); return () => window.removeEventListener('beforeunload', unload);
  }, []);
  useEffect(() => { if (!lock.current) { setName(status.user?.name || ''); setEmail(status.email || ''); } }, [status.user?.name, status.email]);
  async function run(action) {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try {
      await action(); setPassword(''); setConfirm(''); setCurrent('');
      const next = await api.get('/auth/status'); setName(next.user?.name || ''); setEmail(next.email || ''); changed();
    } catch (err) { setError(err.message); }
    finally { lock.current = false; setBusy(false); }
  }
  const canManageTeam = status.configured && status.permissions.includes('manageTeam');
  useEffect(() => { if (!guard.current) setSection(initialSection); }, [initialSection]);
  function navigate(next) {
    if (busy || teamBusy || next === section) return;
    if (dirty && !window.confirm('Discard the unsaved access changes?')) return;
    setName(status.user?.name || ''); setEmail(status.email || ''); setPassword(''); setConfirm(''); setCurrent(''); setTeamDirty(false); setSection(next);
  }
  return <div className="page access-page"><PageHead title="Workspace access" />
    {canManageTeam && <nav className="email-section-nav" aria-label="Access sections"><button className={section === 'account' ? 'on' : ''} onClick={() => navigate('account')}>Your account</button><button className={section === 'team' ? 'on' : ''} onClick={() => navigate('team')}>Team</button></nav>}
    {error && <p className="banner error" role="alert">{error}</p>}
    {section === 'team' && canManageTeam ? <TeamWorkspace status={status} notify={notify} onDirtyChange={setTeamDirty} onBusyChange={setTeamBusy} /> : <>
      <section className="card form access-account"><div className="card-head"><h2><Icon name="lock" size={18}/>{status.configured ? 'Your sign-in' : 'Create an owner account'}</h2><span className="chip">{status.configured ? status.role : 'Local access'}</span></div><form className="form" onSubmit={event => {
        event.preventDefault(); if (password !== confirm) { setError('The new passwords do not match.'); return; }
        run(async () => { await (status.configured ? api.put('/auth/credentials', { name, email, currentPassword: current, newPassword: password }) : api.post('/auth/setup', { name, email, password })); notify?.(status.configured ? 'Account updated' : 'Owner account created', 'success'); });
      }}><fieldset className="form" disabled={busy}><div className="field-row"><label className="field grow"><span>Your name</span><input required maxLength={80} autoComplete="nickname" value={name} onChange={event => setName(event.target.value)} /></label><label className="field grow"><span>Your email</span><input type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} /></label></div>
        {status.configured && <label className="field"><span>Current password</span><input type="password" autoComplete="current-password" required value={current} onChange={event => setCurrent(event.target.value)} /></label>}
        <div className="field-row"><label className="field grow"><span>{status.configured ? 'New password (optional)' : 'Password'}</span><input type="password" autoComplete="new-password" minLength={8} maxLength={200} required={!status.configured} value={password} onChange={event => setPassword(event.target.value)} /></label><label className="field grow"><span>Repeat password</span><input type="password" autoComplete="new-password" minLength={8} maxLength={200} required={!status.configured || Boolean(password)} value={confirm} onChange={event => setConfirm(event.target.value)} /></label></div>
      </fieldset><div className="access-actions"><button className="btn primary" disabled={busy}><Icon name={status.configured?'check':'plus'} size={15}/>{busy ? 'Saving…' : status.configured ? 'Save' : 'Create account'}</button></div></form></section>
      {status.configured && <section className="card form"><h2>Your sessions</h2><p>{status.sessions} active session{status.sessions === 1 ? '' : 's'}.</p><div className="preview-actions"><button className="btn" disabled={busy} onClick={() => run(async () => { const result = await api.post('/auth/logout-others'); notify?.(`${result.signedOut} other sessions signed out`, 'success'); })}>Sign out other sessions</button><button className="btn" disabled={busy} onClick={() => run(() => api.post('/auth/logout'))}>Sign out here</button></div>
        {status.role === 'owner' && <details><summary>Remove workspace sign-in</summary><p className="hint">Disable other team accounts first. Enter your current password above.</p><button className="btn" disabled={busy || !current} onClick={() => { if (window.confirm('Remove sign-in and allow local access on this computer?')) run(() => api.post('/auth/disable', { currentPassword: current })); }}>Remove sign-in</button></details>}
      </section>}
    </>}
  </div>;
}
