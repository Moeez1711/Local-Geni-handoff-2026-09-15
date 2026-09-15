import { useEffect, useRef, useState } from 'react';
import { api, fmt } from '../lib/api.js';
import '../crm.css';
import { Icon, IconButton } from './ui.jsx';
import AccountDialog, { AccountAvatar } from './AccountDialog.jsx';
import { InviteTeammate, TEAM_ROLES } from './TeamInvitation.jsx';

const blank = () => ({ name: '', email: '', role: 'member', password: '' });
const roles = TEAM_ROLES;
export default function TeamWorkspace({ status, notify, onDirtyChange, onBusyChange }) {
  const [rows, setRows] = useState([]), [editor, setEditor] = useState(null), [draft, setDraft] = useState(blank), [saved, setSaved] = useState(blank);
  const [error, setError] = useState(''), [busy, setBusy] = useState(''), [loading, setLoading] = useState(true);
  const [inviting, setInviting] = useState(false), [invitations, setInvitations] = useState([]);
  const lock = useRef(false), alive = useRef(true);
  const dirty = Boolean(editor) && JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  async function load() { const [data, pending] = await Promise.all([api.get('/auth/team'), api.get('/auth/team/invitations')]); if (alive.current) { setRows(data.rows || []); setInvitations(pending.rows || []); } }
  useEffect(() => { alive.current = true; load().catch(err => { if (alive.current) setError(err.message); }).finally(() => { if (alive.current) setLoading(false); }); return () => { alive.current = false; }; }, []);
  function leave() { return !lock.current && (!dirty || window.confirm('Discard the unsaved team changes?')); }
  function edit(row, mode = 'edit') {
    if (!leave()) return;
    const value = row ? { name: row.name, email: row.email, role: row.role, password: '' } : blank();
    setEditor({ row, mode }); setDraft(value); setSaved(value); setError('');
  }
  async function run(name, fn) {
    if (lock.current) return; lock.current = true; setBusy(name); setError('');
    try { await fn(); await load(); if (alive.current) { setEditor(null); setDraft(blank()); setSaved(blank()); } }
    catch (err) { if (alive.current) setError(err.message); }
    finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  function save(event) {
    event.preventDefault();
    run('save', async () => {
      const row = editor.row;
      if (!row) await api.post('/auth/team', draft);
      else if (editor.mode === 'password') await api.post(`/auth/team/${encodeURIComponent(row.id)}/reset-password`, { password: draft.password });
      else await api.patch(`/auth/team/${encodeURIComponent(row.id)}`, { name: draft.name, email: draft.email, role: draft.role });
      notify?.(editor.mode === 'password' ? 'Password reset. Existing sessions were signed out.' : 'Team account saved', 'success');
      window.dispatchEvent(new Event('local-geni-auth-changed'));
    });
  }
  const allowed = row => status.role === 'owner' || row.role !== 'owner';
  return <section className="card form team-workspace"><div className="card-head"><h2><Icon name="leads" size={18}/>Team <span className="account-count">{rows.length}</span></h2><div className="preview-actions"><IconButton icon="person" label="Create account with an initial password" disabled={Boolean(busy)} onClick={() => edit(null)}/><button className="btn primary" disabled={Boolean(busy)} onClick={() => { if (leave()) setInviting(true); }}><Icon name="plus" size={15}/>Invite teammate</button></div></div>
    {error && !editor && <p className="crm-error" role="alert">{error}</p>}
    {loading ? <p role="status">Loading team...</p> : <div className="crm-table-scroll"><table className="crm-table team-table"><thead><tr><th scope="col">Member</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Last sign-in</th><th scope="col">Added</th><th scope="col" className="team-actions-heading">Actions</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td><div className="team-member"><AccountAvatar user={row}/><div><strong>{row.name}{row.id === status.user.id && <span className="team-you">you</span>}</strong><small>{row.email}</small></div></div></td><td><span className="account-role">{roles.find(([key]) => key === row.role)?.[1]}</span></td><td><span className={`account-status ${row.active ? 'active' : 'disabled'}`}>{row.active ? 'Active' : 'Disabled'}</span></td><td title={row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString() : undefined}>{row.lastLoginAt ? fmt.ago(row.lastLoginAt) : 'Never'}</td><td>{new Date(row.createdAt).toLocaleDateString([], {year:'numeric', month:'short', day:'numeric'})}</td><td>{allowed(row) && <div className="team-row-actions"><IconButton icon="edit" label={`Edit ${row.name}`} disabled={Boolean(busy)} onClick={() => edit(row)}/>{row.id !== status.user.id && <><IconButton icon="key" label={`Reset password for ${row.name}`} disabled={Boolean(busy)} onClick={() => edit(row, 'password')}/>{!row.isPrimaryOwner && <IconButton icon={row.active ? 'pause' : 'play'} label={`${row.active ? 'Disable' : 'Enable'} ${row.name}`} disabled={Boolean(busy)} onClick={() => { if (leave() && (!row.active || window.confirm(`Disable ${row.name} and sign out their sessions?`))) run('access', () => api.patch(`/auth/team/${encodeURIComponent(row.id)}`, { active: !row.active })); }}/>}<IconButton icon="signOut" label={`Sign out all sessions for ${row.name}`} disabled={Boolean(busy)} onClick={() => { if (leave() && window.confirm(`Sign out all sessions for ${row.name}?`)) run('sessions', () => api.post(`/auth/team/${encodeURIComponent(row.id)}/revoke-sessions`)); }}/></>}</div>}</td></tr>)}</tbody></table></div>}
    {invitations.some(row => ['pending', 'expired'].includes(row.status)) && <div className="team-invitations"><h3><Icon name="mail" size={16}/>Invitations</h3>{invitations.filter(row => ['pending','expired'].includes(row.status)).map(row => <div className="team-invite-row" key={row.id}><div><strong>{row.name || row.email}</strong>{row.name && <small>{row.email}</small>}</div><span className="account-role">{row.role}</span><span className={`account-status ${row.status}`}>{row.status}</span>{(status.role === 'owner' || row.role !== 'owner') && <IconButton icon="close" label={`Revoke invitation for ${row.email}`} disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Revoke the invitation for ${row.email}?`)) run('invite', () => api.del(`/auth/team/invitations/${encodeURIComponent(row.id)}`)); }}/>}</div>)}</div>}
    {inviting && <InviteTeammate status={status} notify={notify} onClose={() => setInviting(false)} onCreated={() => load().catch(e => { if (alive.current) setError(e.message); })}/>}
    {editor && <AccountDialog title={editor.mode === 'password' ? `Reset password for ${editor.row.name}` : editor.row ? 'Edit teammate' : 'Create team account'} busy={Boolean(busy)} onClose={() => { if (leave()) { setEditor(null); setDraft(blank()); } }}><form onSubmit={save}><div className="account-dialog-body form">{error && <p className="account-error" role="alert">{error}</p>}<fieldset className="form" disabled={Boolean(busy)}>
      {editor.mode !== 'password' && <><div className="field-row"><label className="field grow"><span>Name</span><input autoFocus required maxLength={80} value={draft.name} onChange={event => setDraft(value => ({ ...value, name: event.target.value }))} autoComplete="off" /></label><label className="field grow"><span>Email</span><input required type="email" maxLength={254} value={draft.email} onChange={event => setDraft(value => ({ ...value, email: event.target.value }))} autoComplete="off" /></label></div><label className="field"><span>Role</span><select value={draft.role} disabled={editor.row?.id === status.user.id || editor.row?.isPrimaryOwner} onChange={event => setDraft(value => ({ ...value, role: event.target.value }))}>{roles.filter(([key]) => status.role === 'owner' || key !== 'owner').map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><small>{roles.find(([key]) => key === draft.role)?.[2]}</small></label></>}
      {(!editor.row || editor.mode === 'password') && <label className="field"><span>{editor.row ? 'New password' : 'Initial password'}</span><input required type="password" minLength={8} maxLength={200} autoComplete="new-password" value={draft.password} onChange={event => setDraft(value => ({ ...value, password: event.target.value }))} /><small>Share it with this person privately. No invitation email is sent.</small></label>}
    </fieldset></div><footer><button className="btn" type="button" disabled={Boolean(busy)} onClick={() => { if (leave()) { setEditor(null); setDraft(blank()); } }}>Cancel</button><button className="btn primary" disabled={Boolean(busy)}>{busy ? 'Saving…' : editor.mode === 'password' ? 'Reset password' : 'Save teammate'}</button></footer></form></AccountDialog>}
  </section>;
}
