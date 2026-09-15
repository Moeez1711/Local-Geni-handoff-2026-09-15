import { useEffect, useRef, useState } from 'react';
import { api, fmt } from '../lib/api.js';
import { useWorkspaceAccess } from './AuthWorkspace.jsx';
import { Icon, IconButton } from './ui.jsx';
import AccountDialog, { AccountAvatar } from './AccountDialog.jsx';
import { useSurfaceMotion } from './FluidMotion.jsx';

const authChanged = () => window.dispatchEvent(new Event('local-geni-auth-changed'));
const shortTime = value => value ? new Date(value).toLocaleString([], {dateStyle:'medium', timeStyle:'short'}) : '—';
async function resizeAvatar(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('Choose a PNG, JPEG, or WebP image up to 5 MB.');
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
    const context = canvas.getContext('2d'), side = Math.min(bitmap.width, bitmap.height);
    context.fillStyle = '#fff'; context.fillRect(0, 0, 256, 256);
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally { bitmap.close(); }
}

function ProfileDialog({ status, notify, onClose }) {
  const [draft, setDraft] = useState({name:status.user.name, email:status.user.email, avatar:status.user.avatar || null, currentPassword:'', newPassword:''});
  const [busy, setBusy] = useState(false), [imageBusy, setImageBusy] = useState(false), [error, setError] = useState('');
  const input = useRef(null), lock = useRef(false), alive = useRef(true);
  const dirty = draft.name !== status.user.name || draft.email !== status.user.email || draft.avatar !== (status.user.avatar || null) || Boolean(draft.currentPassword || draft.newPassword);
  const credentialsChanged = draft.email.trim().toLowerCase() !== status.user.email || Boolean(draft.newPassword);
  const change = (key, value) => { setDraft(old => ({...old, [key]:value})); setError(''); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { const guard = e => { if (dirty || busy || imageBusy) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard); }, [dirty, busy, imageBusy]);
  const close = () => { if (!lock.current && !imageBusy && (!dirty || window.confirm('Discard unsaved profile changes?'))) onClose(); };
  async function save(e) {
    e.preventDefault(); if (lock.current || imageBusy) return; lock.current = true; setBusy(true); setError('');
    try { await api.put('/auth/profile', draft); authChanged(); notify?.('Profile saved', 'success'); onClose(); }
    catch (cause) { if (alive.current) setError(cause.message); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  return <AccountDialog title="Profile" onClose={close} busy={busy || imageBusy}>
    <form onSubmit={save}><div className="account-dialog-body form">
      {error && <p className="account-error" role="alert">{error}</p>}
      <div className="profile-picture-row"><AccountAvatar user={draft} className="profile-picture"/><div><div className="preview-actions"><button className="btn" type="button" disabled={busy || imageBusy} onClick={() => input.current?.click()}><Icon name="upload" size={15}/>{imageBusy ? 'Resizing…' : 'Upload picture'}</button>{draft.avatar && <IconButton icon="trash" label="Remove profile picture" disabled={busy || imageBusy} onClick={() => change('avatar', null)}/>}</div><p className="hint">PNG, JPEG or WebP · up to 5 MB</p></div><input className="account-file-input" ref={input} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Profile picture" onChange={async event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file || lock.current || imageBusy) return; setImageBusy(true); setError(''); try { const avatar = await resizeAvatar(file); if (alive.current) change('avatar', avatar); } catch (e) { if (alive.current) setError(e.message || 'This image could not be opened.'); } finally { if (alive.current) setImageBusy(false); } }}/></div>
      <fieldset className="form" disabled={busy || imageBusy}>
        <label className="field"><span>Name</span><input required maxLength={80} autoComplete="nickname" value={draft.name} onChange={e => change('name', e.target.value)}/></label>
        <label className="field"><span>Email</span><input required type="email" maxLength={254} autoComplete="username" value={draft.email} onChange={e => change('email', e.target.value)}/></label>
        <details className="profile-password"><summary><Icon name="lock" size={16}/>Change password</summary><label className="field"><span>New password</span><input type="password" minLength={8} maxLength={200} autoComplete="new-password" placeholder="At least 8 characters" value={draft.newPassword} onChange={e => change('newPassword', e.target.value)}/></label></details>
        {credentialsChanged && <label className="field"><span>Current password</span><input required type="password" autoComplete="current-password" value={draft.currentPassword} onChange={e => change('currentPassword', e.target.value)}/><small className="hint">Required to change your email or password.</small></label>}
      </fieldset>
    </div><footer><button className="btn" type="button" disabled={busy || imageBusy} onClick={close}>Cancel</button><button className="btn primary" disabled={busy || imageBusy || !dirty}><Icon name="check" size={15}/>{busy ? 'Saving…' : 'Save'}</button></footer></form>
  </AccountDialog>;
}

function sessionLabel(agent = '') {
  const app = /Electron/i.test(agent) ? 'Local Geni Desktop' : /Edg\//.test(agent) ? 'Edge' : /Chrome/.test(agent) ? 'Chrome' : /Firefox/.test(agent) ? 'Firefox' : /Safari/.test(agent) ? 'Safari' : 'Browser';
  const system = /iPhone|iPad/.test(agent) ? 'iOS' : /Android/.test(agent) ? 'Android' : /Windows/.test(agent) ? 'Windows' : /Macintosh|Mac OS/.test(agent) ? 'Mac' : /Linux/.test(agent) ? 'Linux' : '';
  return [app, system].filter(Boolean).join(' · ');
}
function SessionsDialog({ notify, onClose }) {
  const [rows, setRows] = useState([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false), alive = useRef(true);
  async function load() { const data = await api.get('/auth/sessions'); if (alive.current) setRows(data.rows || []); }
  useEffect(() => { alive.current = true; load().catch(e => { if (alive.current) setError(e.message); }).finally(() => { if (alive.current) setLoading(false); }); return () => { alive.current = false; }; }, []);
  async function revoke(id) {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { if (id) await api.del(`/auth/sessions/${encodeURIComponent(id)}`); else await api.post('/auth/logout-others'); await load(); authChanged(); notify?.('Sessions updated', 'success'); }
    catch (e) { if (alive.current) setError(e.message); } finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  return <AccountDialog title="Sessions" busy={busy} onClose={onClose}><div className="account-dialog-body form">
    {error && <p className="account-error" role="alert">{error}</p>}
    {loading ? <p role="status">Loading sessions…</p> : rows.map(row => <div className="account-session" key={row.id}><Icon name="shield" size={20}/><div><strong>{sessionLabel(row.userAgent)}</strong><small>Last active {fmt.ago(row.lastSeen)}</small><small title={shortTime(row.createdAt)}>Signed in {shortTime(row.createdAt)}</small></div>{row.current ? <span className="account-status active">This device</span> : <IconButton icon="signOut" label={`Sign out ${sessionLabel(row.userAgent)}`} disabled={busy} onClick={() => revoke(row.id)}/>}</div>)}
  </div><footer><button className="btn" disabled={busy || loading || rows.filter(row => !row.current).length === 0} onClick={() => revoke()}>Sign out other sessions</button><button className="btn primary" disabled={busy} onClick={onClose}>Done</button></footer></AccountDialog>;
}

export default function AccountMenu({ disabled, onSetup, onTeam, notify, beforeSignOut }) {
  const status = useWorkspaceAccess(), [open, setOpen] = useState(false), [panel, setPanel] = useState(''), [busy, setBusy] = useState(false);
  const root = useRef(null), trigger = useRef(null), signOutLock = useRef(false);
  const menuMotion = useSurfaceMotion(open);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector('[role=menuitem]')?.focus();
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const show = next => { close(); setPanel(next); };
  async function signOut() {
    if (signOutLock.current || (beforeSignOut && !beforeSignOut())) return;
    signOutLock.current = true; setBusy(true);
    try { await api.post('/auth/logout'); close(); authChanged(); }
    catch (e) { notify?.(e.message, 'error'); } finally { signOutLock.current = false; setBusy(false); }
  }
  return <>
    <div className="account-menu-wrap" ref={root} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <button ref={trigger} className="account-shortcut" title="Your account" aria-label="Your account" aria-haspopup="menu" aria-expanded={open} disabled={disabled || busy} onClick={() => setOpen(value => !value)}><AccountAvatar user={status.user}/></button>
      {menuMotion.present && <div ref={menuMotion.ref} className="account-menu" role="menu" aria-label="Your account" inert={!open || undefined} aria-hidden={!open || undefined} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const items = [...event.currentTarget.querySelectorAll('[role=menuitem]:not(:disabled)')], index = items.indexOf(document.activeElement); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
      }}>
        <div className="account-menu-identity"><AccountAvatar user={status.user}/><div><strong>{status.user?.name || 'Local workspace'}</strong><span>{status.user?.email || 'Set up your account'}</span><small>{status.configured ? status.role : 'Local access'}</small></div></div>
        {status.configured ? <><button role="menuitem" onClick={() => show('profile')}><Icon name="person" size={18}/>Profile</button><button role="menuitem" onClick={() => show('sessions')}><Icon name="shield" size={18}/>Sessions</button>{status.permissions.includes('manageTeam') && <button role="menuitem" onClick={() => { close(); onTeam(); }}><Icon name="leads" size={18}/>Team</button>}<button className="account-signout" role="menuitem" disabled={busy} onClick={signOut}><Icon name="signOut" size={18}/>{busy ? 'Signing out…' : 'Sign out'}</button></> : <button role="menuitem" onClick={() => { close(); onSetup(); }}><Icon name="person" size={18}/>Create account</button>}
      </div>}
    </div>
    {panel === 'profile' && status.configured && <ProfileDialog status={status} notify={notify} onClose={() => { setPanel(''); trigger.current?.focus(); }}/>}
    {panel === 'sessions' && status.configured && <SessionsDialog notify={notify} onClose={() => { setPanel(''); trigger.current?.focus(); }}/>}
  </>;
}
