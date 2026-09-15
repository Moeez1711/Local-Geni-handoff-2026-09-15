import { useEffect, useRef, useState } from 'react';
import { extractPhoneColumn, suggestPhoneColumn } from '../lib/smsImport.js';
import { Icon } from './ui.jsx';

export default function SmsRecipientImport({ onAdd, onBusyChange, onDraftChange }) {
  const [file, setFile] = useState(null), [sheetIndex, setSheetIndex] = useState(0);
  const [column, setColumn] = useState(0), [hasHeader, setHasHeader] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [dragging, setDragging] = useState(false);
  const input = useRef(null), worker = useRef(null), timeout = useRef(null);
  useEffect(() => () => { worker.current?.terminate(); clearTimeout(timeout.current); onBusyChange(false); }, [onBusyChange]);
  useEffect(() => { onDraftChange(Boolean(file)); return () => onDraftChange(false); }, [file, onDraftChange]);
  function chooseSheet(sheets, index) {
    const suggestion = suggestPhoneColumn(sheets[index].rows);
    setSheetIndex(index); setColumn(suggestion.column); setHasHeader(suggestion.hasHeader);
  }
  function load(files) {
    if (busy) return;
    if (files.length !== 1) { setError('Choose one file at a time.'); return; }
    const selected = files[0];
    setError(''); setBusy(true); onBusyChange(true);
    const active = new Worker(new URL('../lib/smsImport.worker.js', import.meta.url), { type: 'module' });
    worker.current = active;
    function finish() { active.terminate(); worker.current = null; clearTimeout(timeout.current); setBusy(false); onBusyChange(false); }
    active.onmessage = ({ data }) => {
      finish();
      if (data.error) { setError(data.error); return; }
      setFile({ name: selected.name, sheets: data.sheets }); chooseSheet(data.sheets, 0);
    };
    active.onerror = () => { finish(); setError('This file could not be read. Try exporting it as CSV.'); };
    timeout.current = setTimeout(() => { finish(); setError('This file took too long to read. Export only the phone column as CSV.'); }, 20000);
    active.postMessage(selected);
  }
  const sheet = file?.sheets[sheetIndex];
  const result = sheet ? extractPhoneColumn(sheet.rows, column, hasHeader) : null;
  const columns = sheet ? Math.max(...sheet.rows.map(row => row.length)) : 0;
  return <div className="sms-file-import">
    <input ref={input} hidden type="file" accept=".csv,.xlsx,.tsv,.txt" aria-label="Upload SMS recipients" disabled={busy} onChange={event => { if (event.target.files.length) load(event.target.files); event.target.value = ''; }}/>
    <button type="button" className={`sms-upload-zone ${dragging ? 'dragging' : ''}`} disabled={busy} onClick={() => input.current.click()}
      onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={event => { event.preventDefault(); setDragging(false); if (!busy) load(event.dataTransfer.files); }}>
      <Icon name={busy ? 'loading' : file ? 'spreadsheet' : 'upload'} size={23}/>
      <strong>{busy ? 'Reading file…' : file ? file.name : 'Drop a file or browse'}</strong>
      <span>{file && !busy ? 'Choose another file' : 'CSV · Excel (.xlsx) · TSV · TXT · 2 MB'}</span>
    </button>
    {error && <p className="integration-connection-error" role="alert">{error}</p>}
    {sheet && <div className="sms-file-mapping">
      {file.sheets.length > 1 && <label className="field"><span>Sheet</span><select value={sheetIndex} onChange={event => chooseSheet(file.sheets, Number(event.target.value))}>{file.sheets.map((item, index) => <option key={index} value={index}>{item.name}</option>)}</select></label>}
      <label className="field"><span>Phone column</span><select value={column} onChange={event => setColumn(Number(event.target.value))}>{Array.from({ length: columns }, (_, index) => <option key={index} value={index}>{hasHeader && sheet.rows[0]?.[index] ? sheet.rows[0][index] : `Column ${index + 1}`}</option>)}</select></label>
      <label className="system-auto-check"><input type="checkbox" checked={hasHeader} onChange={event => setHasHeader(event.target.checked)}/><span>First row contains headings</span></label>
      <div className="sms-import-preview"><header><strong>{result.numbers.length} ready</strong><span>{result.duplicates} duplicates · {result.invalid.length} invalid · {result.blanks} blank</span></header>
        {result.numbers.length > 0 && <ul>{result.numbers.slice(0, 4).map(number => <li key={number}><Icon name="phone" size={13}/>{number}</li>)}{result.numbers.length > 4 && <li className="muted">+{result.numbers.length - 4} more</li>}</ul>}
        {result.invalid.length > 0 && <details><summary>Check invalid rows</summary><p>Use country codes, for example +14155550123. Keep phone cells as text.</p><ul>{result.invalid.slice(0, 20).map(item => <li key={item.row}>Row {item.row}: {item.value}</li>)}</ul>{result.invalid.length > 20 && <small>{result.invalid.length - 20} more invalid rows</small>}</details>}
      </div>
      {result.numbers.length > 1000 && <p className="integration-connection-error">Choose up to 1,000 unique numbers per batch.</p>}
      <button type="button" className="btn" disabled={busy || !result.numbers.length || result.numbers.length > 1000} onClick={() => { if (onAdd(result.numbers, file.name)) { setFile(null); setError(''); } }}><Icon name="plus" size={15}/>Add {result.numbers.length} valid numbers</button>
    </div>}
  </div>;
}
