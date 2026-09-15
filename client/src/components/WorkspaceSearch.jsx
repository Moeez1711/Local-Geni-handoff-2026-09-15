import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api.js';
import { Icon } from './ui.jsx';
import { useSurfaceMotion } from './FluidMotion.jsx';

export default function WorkspaceSearch({ navigation, onNavigate, onOpenLead, busy, compact, onToggleDensity, modalOpen }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef(null), restoreFocus = useRef(null), trigger = useRef(null);
  const { ref: panel, present } = useSurfaceMotion(open, { anchor: trigger });
  const eligible = !busy && !modalOpen;
  const pages = navigation.filter(([, , label]) => label.toLowerCase().includes(query.trim().toLowerCase())).slice(0, query ? 7 : 9);
  const results = [
    ...pages.map(([id, icon, label]) => ({ id: `page:${id}`, icon, label, detail: 'Workspace', run: () => onNavigate(id) })),
    ...rows.map(row => ({ id: `lead:${row.place_id}`, icon: 'building', label: row.name, detail: row.address || row.category || 'Business', run: () => onOpenLead(row.place_id) })),
  ];
  useEffect(() => {
    function shortcut(event) {
      if (!eligible) return;
      if (event.type === 'local-geni-search' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')) {
        event.preventDefault(); setOpen(value => !value);
      }
    }
    window.addEventListener('keydown', shortcut);
    window.addEventListener('local-geni-search', shortcut);
    return () => { window.removeEventListener('keydown', shortcut); window.removeEventListener('local-geni-search', shortcut); };
  }, [eligible]);
  useEffect(() => {
    if (!open) return undefined;
    restoreFocus.current = document.activeElement;
    const shell = document.querySelector('.shell'), previouslyInert = shell?.inert;
    if (shell) shell.inert = true;
    input.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; if (shell) shell.inert = previouslyInert; restoreFocus.current?.focus?.(); };
  }, [open]);
  useEffect(() => {
    setCursor(0); setRows([]); setError('');
    if (!open || query.trim().length < 2) { setLoading(false); return undefined; }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      api.get(`/leads?q=${encodeURIComponent(query.trim())}&limit=6`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setRows(result.rows || []); }).catch(err => { if (!controller.signal.aborted) setError(err.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, query]);
  useEffect(() => { panel.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [cursor]);
  function close() { setOpen(false); setQuery(''); setRows([]); }
  function choose(result) { if (result && !busy && result.run() !== false) close(); }
  function keydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const elements = [...panel.current.querySelectorAll('button:not(:disabled),input')];
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }
  return <>
    <button ref={trigger} className="workspace-search-trigger" onClick={() => setOpen(true)} disabled={!eligible} aria-label="Search businesses and pages" aria-keyshortcuts="Meta+K Control+K"><Icon name="search" size={16} /><span>Search</span><kbd>Ctrl / Cmd K</kbd></button>
    <button className="workspace-quick-trigger" onClick={() => { setQuery(''); setOpen(true); }} disabled={!eligible}><Icon name="plus" size={14} /><span>Actions</span></button>
    {present && createPortal(<div className={`workspace-search-backdrop ${open ? '' : 'surface-closing'}`} aria-hidden={!open || undefined} inert={!open || undefined} onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><section className="workspace-search-dialog" ref={panel} role="dialog" aria-modal="true" aria-label="Search workspace" onKeyDown={keydown}>
      <header><Icon name="search" size={18} /><input ref={input} aria-label="Search businesses and pages" role="combobox" aria-expanded="true" aria-controls="workspace-search-results" aria-activedescendant={results[cursor] ? `search-result-${cursor}` : undefined} value={query} placeholder="Search" onChange={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setCursor(value => results.length ? (value + 1) % results.length : 0); }
        if (event.key === 'ArrowUp') { event.preventDefault(); setCursor(value => results.length ? (value - 1 + results.length) % results.length : 0); }
        if (event.key === 'Enter') { event.preventDefault(); choose(results[cursor]); }
      }} /><button className="icon-btn" aria-label="Close search" onClick={close}><Icon name="close" size={16} /></button></header>
      <div className="workspace-search-results" id="workspace-search-results" role="listbox" aria-label="Results">{results.map((result, index) => <button type="button" role="option" tabIndex={-1} aria-selected={cursor === index} id={`search-result-${index}`} key={result.id} onMouseEnter={() => setCursor(index)} onClick={() => choose(result)}><Icon name={result.icon} size={18} /><span><strong>{result.label}</strong><small>{result.detail}</small></span><Icon name="arrowUpRight" size={14} /></button>)}</div>
      {loading && <p role="status">Searching businesses...</p>}{error && <p role="alert">Business search failed. Try another search.</p>}{!loading && !results.length && <p>No matching businesses or pages</p>}
      <footer><span>Arrow keys / Enter</span><button className="btn ghost" aria-pressed={compact} onClick={onToggleDensity}>{compact ? 'Comfortable rows' : 'Compact rows'}</button></footer>
    </section></div>, document.body)}
  </>;
}
