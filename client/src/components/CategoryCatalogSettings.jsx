import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon, IconButton, PageHead } from './ui.jsx';
import { CATEGORY_LANGUAGES } from './CategoryPicker.jsx';
import { useWorkspaceAccess } from './AuthWorkspace.jsx';

export default function CategoryCatalogSettings({ meta, notify, onDirtyChange, onBusyChange }) {
  const access = useWorkspaceAccess(), canManage = access.permissions.includes('manageConnections');
  const [status, setStatus] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const [clientId, setClientId] = useState(''), [clientSecret, setClientSecret] = useState('');
  const [country, setCountry] = useState('US'), [language, setLanguage] = useState('en');
  const lock = useRef(false), alive = useRef(true);
  const dirty = Boolean(clientSecret || status && clientId !== status.clientId);
  const redirectUri = `${window.location.origin}/oauth/google-categories`;
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    alive.current = true;
    try { const form = JSON.parse(localStorage.getItem('leadscout.config') || '{}'); setCountry(form.country || 'US'); setLanguage(form.language || 'en'); } catch { /* defaults */ }
    let result;
    try { result = JSON.parse(sessionStorage.getItem('local-geni-category-result') || 'null'); sessionStorage.removeItem('local-geni-category-result'); } catch { /* no connection result */ }
    if (result) {
      if (result.denied || !result.code) { setError('Google connection was cancelled or expired. Start the connection again.'); load(); }
      else run('connecting', async () => { receive(await api.post('/categories/oauth/complete', result)); notify('Google connected. Choose a country and import its categories.', 'success'); });
    } else load();
    return () => { alive.current = false; };
  }, []);
  function receive(next) { if (!alive.current) return; setStatus(next); setClientId(next.clientId || ''); setClientSecret(''); }
  function load() { api.get('/categories/status').then(receive).catch(err => { if (alive.current) setError(err.message); }); }
  async function run(name, action) {
    if (lock.current) return;
    lock.current = true; setBusy(name); setError('');
    try { await action(); } catch (err) { if (alive.current) setError(err.message); }
    finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  async function connect() {
    const result = await api.post('/categories/oauth/begin');
    sessionStorage.setItem('local-geni-category-state', result.state);
    window.location.assign(result.url);
  }
  const editable = canManage && !status?.simulated;
  return <div className="page catalogue-page"><PageHead title="Business categories" description="Choose from the bundled catalogue, import Google categories, or search any custom business type."/>
    <div className="catalogue-settings">
      <section className="catalogue-overview"><Icon name="building" size={28}/><div><h3>{status?.bundled.count?.toLocaleString() || meta?.categories.length?.toLocaleString()} categories ready to search</h3><p>The bundled catalogue combines specialist business types with Google Places categories. Search by name or common terms, save favourites, and enter any business type that is missing.</p><p className="hint">Google’s Business Profile catalogue varies by country and language. Import more than one region; matching Google IDs appear once.</p></div></section>
      {error && <p className="banner error" role="alert">{error}</p>}
      {!status && !error && <p role="status">Loading category settings…</p>}
      {status && <>
        <section className="card"><header className="card-head"><h3><Icon name="globe" size={19}/>Google Business Profile</h3><span className={`chip ${status.connected ? 'good' : ''}`}>{status.connected ? 'Connected' : 'Not connected'}</span></header>
          <p className="catalogue-connection-note">Use a Google OAuth client from a project approved for the Business Profile APIs. Enable the Business Profile Business Information API and add the redirect URL below. This connection is separate from your Places search API key. <a href="https://developers.google.com/my-business/content/basic-setup" target="_blank" rel="noreferrer">Google setup guide <Icon name="external" size={12}/></a></p>
          {status.simulated && <p className="hint">Connections and imports are disabled in this sample workspace. The bundled catalogue and custom searches remain available.</p>}
          <div className="catalogue-redirect"><code>{redirectUri}</code><IconButton icon="copy" label="Copy Google redirect URL" onClick={() => navigator.clipboard.writeText(redirectUri).then(() => notify('Redirect URL copied', 'success')).catch(() => notify('Copy the redirect URL shown here.', 'error'))}/></div>
          {canManage && <form onSubmit={event => { event.preventDefault(); run('save', async () => { receive(await api.put('/categories/connection', { clientId, clientSecret })); notify('Google client saved', 'success'); }); }}>
            <fieldset disabled={!editable || Boolean(busy)} className="catalogue-fields"><label className="field"><span>OAuth client ID</span><input autoComplete="off" value={clientId} onChange={event => setClientId(event.target.value)} placeholder="…apps.googleusercontent.com" required/></label><label className="field"><span>Client secret</span><input type="password" autoComplete="new-password" value={clientSecret} onChange={event => setClientSecret(event.target.value)} placeholder={status.configured ? 'Saved securely · leave blank to keep' : 'Enter client secret'} required={!status.configured}/></label></fieldset>
            <div className="catalogue-actions"><button type="submit" className="btn" disabled={!editable || Boolean(busy) || !dirty || !clientId.trim()}><Icon name="check" size={15}/>{busy === 'save' ? 'Saving…' : 'Save client'}</button><button type="button" className="btn primary" disabled={!editable || Boolean(busy) || !status.configured || dirty} onClick={() => run('connecting', connect)}><Icon name="plug" size={15}/>{busy === 'connecting' ? 'Connecting…' : status.connected ? 'Reconnect Google' : 'Connect Google'}</button>{status.configured && <button type="button" className="btn ghost" disabled={!editable || Boolean(busy)} onClick={() => run('disconnect', async () => { receive(await api.del('/categories/connection')); notify('Google disconnected. Imported categories are kept.', 'success'); })}>Disconnect</button>}</div>
          </form>}
        </section>
        <section className="card"><header className="card-head"><h3><Icon name="refresh" size={19}/>Import & refresh</h3><span className="muted small">{status.locales.length} saved locales</span></header>
          <div className="catalogue-sync-controls"><label className="field"><span>Country</span><select disabled={Boolean(busy)} value={country} onChange={event => setCountry(event.target.value)}>{meta?.countries.map(row => <option key={row.code} value={row.code}>{row.name}</option>)}</select></label><label className="field"><span>Language</span><input list="catalogue-languages" disabled={Boolean(busy)} value={language} maxLength={35} onChange={event => setLanguage(event.target.value)} placeholder="en"/><datalist id="catalogue-languages">{CATEGORY_LANGUAGES.map(([code, label]) => <option value={code} key={code}>{label}</option>)}</datalist></label><button type="button" className="btn primary" disabled={!editable || Boolean(busy) || !status.connected || !language.trim()} onClick={() => run('refresh', async () => { const result = await api.post('/categories/refresh', { country, language }); receive(result.status); notify(`${result.googleCount.toLocaleString()} Google categories imported`, 'success'); })}><Icon name="refresh" size={15}/>{busy === 'refresh' ? 'Importing all pages…' : 'Import categories'}</button></div>
          <label className="catalogue-auto"><input type="checkbox" checked={status.autoRefresh} disabled={!editable || !status.connected || Boolean(busy)} onChange={event => run('automatic', async () => receive(await api.put('/categories/automatic', { enabled: event.target.checked })))}/><span>Refresh saved locales every 30 days<small className="hint">Checked while Local Geni is running. Existing categories stay available if Google is unavailable.</small></span></label>
          <div className="catalogue-locales">{status.locales.map(row => <div key={row.locale} className="catalogue-locale"><strong>{meta?.countries.find(item => item.code === row.country)?.name || row.country} · {row.language}</strong><span>{row.count.toLocaleString()} categories</span><small>{row.updatedAt ? `Updated ${new Date(row.updatedAt).toLocaleString()}` : 'Not imported yet'}</small><button className="link" disabled={!editable || Boolean(busy) || !status.connected} onClick={() => { setCountry(row.country); setLanguage(row.language); }}>Select</button>{row.error && <small className="error">{row.error}</small>}</div>)}</div>
          {!status.locales.length && <p className="hint">Import a country and language to start. Your bundled categories are already available in Find businesses.</p>}
        </section>
      </>}
    </div>
  </div>;
}
