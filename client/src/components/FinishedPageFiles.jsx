import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

const MAX_BYTES = 3 * 1024 * 1024;
const noop = () => {};
const endpoint = (id) => `/preview-files/${encodeURIComponent(id)}`;
const sizeLabel = (size) => size < 1024 ? `${size} bytes` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
async function saveDownload(response, fallbackName) {
  const filename = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] || fallbackName;
  const url = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: 'application/octet-stream' }));
  const anchor = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function FinishedPagesExportButton({ ids, notify = noop }) {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const selected = [...new Set(Array.from(ids || []))];
  async function download() {
    if (lock.current || !selected.length || selected.length > 25) return;
    lock.current = true; setBusy(true);
    try { const response = await api.post('/preview-files/export-zip', { placeIds: selected }, { raw: true }); await saveDownload(response, 'finished-homepages.zip'); notify('Finished pages ZIP download started', 'success'); }
    catch (err) { notify(err.message, 'error'); }
    finally { lock.current = false; setBusy(false); }
  }
  return <button className="btn xs" type="button" disabled={busy || !selected.length || selected.length > 25} title={selected.length > 25 ? 'Select up to 25 businesses for a finished pages ZIP.' : 'Download saved HTML pages from the selected businesses. Maximum 25 MB total.'} onClick={download}>{busy ? 'Preparing ZIP...' : 'Export finished pages'}</button>;
}

export default function FinishedPageFiles({ placeId, disabled = false, notify = noop, onBusyChange, onDirtyChange, onSaved }) {
  const [data, setData] = useState(null);
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const input = useRef(null);
  const alive = useRef(true);
  const lock = useRef(false);
  useEffect(() => {
    alive.current = true; const controller = new AbortController(); setLoading(true); setError(''); setData(null); setFile(null);
    api.get(endpoint(placeId), { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setData(value); }).catch(err => { if (!controller.signal.aborted) setError(err.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { alive.current = false; controller.abort(); };
  }, [placeId]);
  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(Boolean(file)); return () => onDirtyChange?.(false); }, [file, onDirtyChange]);
  function choose(next) {
    setError('');
    if (!next) return;
    if (!/\.html?$/i.test(next.name) || !next.size || next.size > MAX_BYTES) { setFile(null); setError('Choose a non-empty .html or .htm file, up to 3 MB.'); if (input.current) input.current.value = ''; return; }
    setFile(next);
  }
  async function upload() {
    if (!file || lock.current || disabled) return; lock.current = true; setBusy('upload'); setError('');
    try {
      const contentBase64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('This file could not be read. Choose it again.')); reader.readAsDataURL(file); });
      const next = await api.post(endpoint(placeId), { filename: file.name, contentBase64 });
      if (alive.current) { setData(next); setFile(null); if (input.current) input.current.value = ''; notify(next.unchanged ? 'This finished page is already saved' : 'Finished page saved', 'success'); try { await onSaved?.(); } catch { notify('The file is saved. Refresh the business list to update its project entry.', 'info'); } }
    } catch (err) { if (alive.current) setError(err.message); }
    finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  async function download(version) {
    if (lock.current || disabled) return; lock.current = true; setBusy(version.id); setError('');
    try { const response = await api.get(`${endpoint(placeId)}/download?versionId=${encodeURIComponent(version.id)}`, { raw: true }); await saveDownload(response, version.filename); notify('Finished HTML download started', 'success'); }
    catch (err) { if (alive.current) setError(err.message); }
    finally { lock.current = false; if (alive.current) setBusy(''); }
  }
  const locked = disabled || loading || Boolean(busy);
  return <section className="card form" aria-labelledby="finished-page-title">
    <div><h3 id="finished-page-title">Finished page file</h3><p className="hint">Save the HTML exported from your separate design system, then download it when needed.</p></div>
    <p className="hint">Files are kept exactly as supplied. Linked assets remain as provided; use self-contained HTML for offline use. This private file does not create a public outreach link.</p>
    {error && <p className="email-status-note bad" role="alert">{error}</p>}
    <label className="field"><span>Choose finished HTML / up to 3 MB</span><input ref={input} type="file" accept=".html,.htm,text/html" disabled={locked} onChange={event => choose(event.target.files?.[0])} /></label>
    {file && <div className="preview-actions"><span className="hint">{file.name} / {sizeLabel(file.size)}</span><button className="btn primary" disabled={locked} onClick={upload}>{busy === 'upload' ? 'Saving...' : 'Save finished page'}</button><button className="btn" disabled={locked} onClick={() => { setFile(null); if (input.current) input.current.value = ''; }}>Discard file selection</button></div>}
    {loading ? <p className="hint" role="status">Loading saved files...</p> : data?.current ? <>
      <div className="preview-actions"><div className="grow"><strong>{data.current.filename}</strong><p className="hint">Version {data.current.revision} / {sizeLabel(data.current.size)} / {new Date(data.current.createdAt).toLocaleString()}</p></div><button className="btn primary" disabled={locked} onClick={() => download(data.current)}>{busy === data.current.id ? 'Preparing download...' : 'Export finished HTML'}</button></div>
      <details><summary>File details and earlier versions</summary><div className="form mt-3"><p className="hint break">Current SHA-256: {data.current.sha256}</p><p className="hint">Saving a different file adds a version. Earlier files are kept.</p>{data.versions?.filter(version => version.id !== data.current.id).map(version => <div className="preview-actions" key={version.id}><span className="hint grow">Version {version.revision}: {version.filename} / {sizeLabel(version.size)}</span><button className="btn xs" disabled={locked} onClick={() => download(version)}>Download version {version.revision}</button></div>)}</div></details>
    </> : !loading && <p className="hint">No finished HTML file saved for this business.</p>}
  </section>;
}
