import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon, IconButton } from './ui.jsx';
import AccountDialog from './AccountDialog.jsx';
import BrandMark from './BrandMark.jsx';

export const TEAM_ROLES = [['owner','Owner','Full access, including owner accounts.'], ['admin','Admin','Manage the workspace, connections and team.'], ['member','Member','Manage leads, deals and outreach.'], ['viewer','Viewer','View records and export data.']];
export function InviteTeammate({ status, onClose, onCreated, notify }) {
  const [draft, setDraft] = useState({email:'', name:'', role:'member'}), [workspaceUrl, setWorkspaceUrl] = useState(window.location.origin);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [created, setCreated] = useState(null), [link, setLink] = useState('');
  const lock = useRef(false), alive = useRef(true);
  const dirty = !created && Boolean(draft.email || draft.name || draft.role !== 'member' || workspaceUrl !== window.location.origin);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { const guard = e => { if (dirty || busy) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard); }, [dirty, busy]);
  function close() { if (!lock.current && (!dirty || window.confirm('Discard this invitation draft?'))) onClose(); }
  async function create(event) {
    event.preventDefault(); if (lock.current) return;
    let base;
    try { base = new URL(workspaceUrl); if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error(); }
    catch { setError('Enter the HTTP or HTTPS address used to open this workspace.'); return; }
    lock.current = true; setBusy(true); setError('');
    try { const data = await api.post('/auth/team/invitations', draft); if (alive.current) { setCreated(data.invitation); setLink(`${base.href.replace(/\/$/, '')}/#join=${data.token}`); onCreated?.(); } }
    catch (e) { if (alive.current) setError(e.message); } finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  const emailBody = created ? `Hi${created.name ? ` ${created.name}` : ''},\n\nJoin my Local Geni workspace as a ${created.role}:\n${link}\n\nChoose your name and password to finish joining. This invitation expires in 7 days.\n\n${status.user.name}` : '';
  return <AccountDialog title={created ? 'Invitation ready' : 'Invite a teammate'} onClose={close} busy={busy}>
    {created ? <><div className="account-dialog-body form"><div className="invite-ready"><span><Icon name="check" size={23}/></span><div><strong>{created.email}</strong><p>{TEAM_ROLES.find(([key]) => key === created.role)?.[1]} · expires {new Date(created.expiresAt).toLocaleDateString()}</p></div></div><label className="field"><span>Invitation link</span><div className="invite-link"><input readOnly value={link} onFocus={e => e.target.select()}/><IconButton icon="copy" label="Copy invitation link" onClick={async () => { try { await navigator.clipboard.writeText(link); notify?.('Invitation link copied', 'success'); } catch { setError('Select the invitation link and copy it manually.'); } }}/></div></label><p className="hint">Share this private link with your teammate. They need access to the workspace address.</p>{error && <p className="account-error" role="alert">{error}</p>}</div><footer><button className="btn" onClick={onClose}>Done</button><a className="btn primary" href={`mailto:${encodeURIComponent(created.email)}?subject=${encodeURIComponent('Join my Local Geni workspace')}&body=${encodeURIComponent(emailBody)}`}><Icon name="mail" size={16}/>Open email draft</a></footer></> : <form onSubmit={create}><div className="account-dialog-body form">
      {error && <p className="account-error" role="alert">{error}</p>}
      <fieldset className="form" disabled={busy}>
        <label className="field"><span>Email</span><input autoFocus type="email" required maxLength={254} autoComplete="off" placeholder="teammate@company.com" value={draft.email} onChange={e => setDraft({...draft,email:e.target.value})}/></label>
        <label className="field"><span>Name <em>· optional</em></span><input maxLength={80} autoComplete="off" placeholder="Their name" value={draft.name} onChange={e => setDraft({...draft,name:e.target.value})}/></label>
        <label className="field"><span>Role</span><select value={draft.role} onChange={e => setDraft({...draft,role:e.target.value})}>{TEAM_ROLES.filter(([key]) => status.role === 'owner' || key !== 'owner').map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select><small className="hint">{TEAM_ROLES.find(([key]) => key === draft.role)?.[2]}</small></label>
        <label className="field"><span>Workspace address</span><input type="url" required value={workspaceUrl} onChange={e => setWorkspaceUrl(e.target.value)}/><small className="hint">Use an address your teammate can reach. A localhost address works only on this computer.</small></label>
      </fieldset>
    </div><footer><button className="btn" type="button" disabled={busy} onClick={close}>Cancel</button><button className="btn primary" disabled={busy}><Icon name="plus" size={16}/>{busy ? 'Creating…' : 'Create invitation'}</button></footer></form>}
  </AccountDialog>;
}

export function JoinWorkspace({ token, onJoined }) {
  const [invitation, setInvitation] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [name, setName] = useState(''), [password, setPassword] = useState(''), [repeat, setRepeat] = useState('');
  const lock = useRef(false);
  useEffect(() => { const controller = new AbortController(); setLoading(true); setInvitation(null); setError(''); api.post('/auth/invitation/lookup', {token}, {signal:controller.signal}).then(data => { if (!controller.signal.aborted) { setInvitation(data.invitation); setName(data.invitation.name); } }).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, [token]);
  return <main className="auth-shell"><section className="auth-card"><div className="auth-wordmark"><BrandMark size={36}/>Local Geni</div><h1>Join the workspace</h1>
    {loading && <p role="status">Checking invitation…</p>}{error && <p className="account-error" role="alert">{error}</p>}
    {invitation && <form className="form" onSubmit={async e => { e.preventDefault(); if (lock.current) return; if (password !== repeat) { setError('The passwords do not match.'); return; } lock.current = true; setBusy(true); setError(''); try { await api.post('/auth/invitation/accept', {token,name,password}); setPassword(''); setRepeat(''); await onJoined(); } catch (cause) { setError(cause.message); } finally { lock.current = false; setBusy(false); } }}>
      <p className="hint">{invitation.email} · {TEAM_ROLES.find(([key]) => key === invitation.role)?.[1]}</p><fieldset className="form" disabled={busy}>
        <label className="field"><span>Your name</span><input required maxLength={80} autoComplete="nickname" value={name} onChange={e => setName(e.target.value)}/></label>
        <label className="field"><span>Password</span><input required type="password" minLength={8} maxLength={200} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)}/></label>
        <label className="field"><span>Repeat password</span><input required type="password" minLength={8} maxLength={200} autoComplete="new-password" value={repeat} onChange={e => setRepeat(e.target.value)}/></label>
      </fieldset><button className="btn primary" disabled={busy}>{busy ? 'Joining…' : 'Join workspace'}<Icon name="arrowUpRight" size={16}/></button>
    </form>}
    <a className="auth-back-link" href="#home">Back to sign in</a>
  </section></main>;
}
