import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon } from './ui.jsx';
import ProviderIcon from './ProviderIcon.jsx';

export default function IntegrationConnection({ provider, connection, simulated, unavailable, onChanged, onClose, onDirtyChange, onBusyChange }) {
  const [values, setValues] = useState({}), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const lock = useRef(false), alive = useRef(true);
  const dirty = Object.values(values).some(Boolean);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const unload = e => { if (dirty || lock.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', unload); return () => window.removeEventListener('beforeunload', unload);
  }, [dirty]);
  async function run(action) {
    if (lock.current || unavailable) return;
    if (action === 'disconnect' && !window.confirm(`Disconnect ${provider.name}?`)) return;
    lock.current = true; setBusy(action); setError(''); setNotice('');
    try {
      let result;
      if (action === 'save') {
        result = await api.put(`/integrations/${provider.id}`, values);
        if (alive.current) { onChanged(result); setValues({}); }
        result = await api.post(`/integrations/${provider.id}/verify`);
      } else if (action === 'verify') result = await api.post(`/integrations/${provider.id}/verify`);
      else result = await api.del(`/integrations/${provider.id}`);
      if (alive.current) { onChanged(result); setValues({}); setNotice(action === 'disconnect' ? 'Disconnected' : simulated ? 'Saved in sample mode' : 'Connection verified'); }
    } catch (err) {
      if (alive.current) setError(err.message);
      try { const fresh = await api.get(`/integrations/${provider.id}`); if (alive.current) onChanged(fresh); } catch {}
    } finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  return <section className="card integration-connection" aria-labelledby="connection-title">
    <header className="integration-connection-head"><div className="provider-label"><ProviderIcon provider={provider.id} size={24}/><h2 id="connection-title">{provider.name}</h2></div><button className="ci" disabled={Boolean(busy)} onClick={onClose} title="Close setup" aria-label="Close integration setup"><Icon name="close" size={18}/></button></header>
    {unavailable && <p role="alert">Connection setup is unavailable. Reload after restarting Local Geni.</p>}
    {simulated && <p className="integration-connection-note">Sample mode. Use test credentials. Provider calls are simulated.</p>}
    <form onSubmit={e => { e.preventDefault(); run('save'); }}>
      <fieldset disabled={Boolean(busy) || unavailable}>
        {(provider.fields || []).map(field => <label className="field" key={field.name}><span>{field.label}</span><input type={field.secret ? 'password' : 'text'} autoComplete={field.secret ? 'new-password' : 'off'} spellCheck={false} maxLength={field.multiline ? 20000 : 2048} value={values[field.name] || ''} onChange={e => setValues(v => ({ ...v, [field.name]: e.target.value }))} required={!connection?.configured} placeholder={connection?.configured ? 'Saved • Leave blank to keep' : field.placeholder || `Paste ${field.label.toLowerCase()}`}/></label>)}
        <details className="integration-help"><summary>Setup guide</summary><p>{provider.help}</p><a href={provider.docs} target="_blank" rel="noreferrer">Provider guide <Icon name="external" size={12}/></a></details>
      </fieldset>
      {error && <p className="integration-connection-error" role="alert">{error}</p>}
      {notice && <p className="integration-connection-notice" role="status">{notice}</p>}
      {connection?.verifiedAt && <p className="hint">Last checked {new Date(connection.verifiedAt).toLocaleString()}</p>}
      <footer><button className="btn primary" disabled={Boolean(busy) || unavailable || !dirty}><Icon name="plug" size={14}/>{busy === 'save' ? 'Connecting…' : simulated ? 'Save' : 'Connect'}</button>
        {connection?.configured && <><button className="ci" type="button" disabled={Boolean(busy) || unavailable || dirty} onClick={() => run('verify')} title="Check connection" aria-label={`Check ${provider.name} connection`}><Icon name="refresh" size={16}/></button><button className="ci danger" type="button" disabled={Boolean(busy) || unavailable || dirty} onClick={() => run('disconnect')} title="Disconnect" aria-label={`Disconnect ${provider.name}`}><Icon name="disconnect" size={16}/></button></>}
      </footer>
    </form>
  </section>;
}
