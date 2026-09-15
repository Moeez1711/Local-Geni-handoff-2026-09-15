import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, qs } from '../lib/api.js';
import { categoryKey, searchCategories } from '../../../shared/categorySearch.js';
import { Icon } from './ui.jsx';

export const CATEGORY_LANGUAGES = [['en', 'English'], ['ar', 'Arabic'], ['ur', 'Urdu'], ['hi', 'Hindi'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt-BR', 'Portuguese (Brazil)'], ['pt', 'Portuguese'], ['it', 'Italian'], ['nl', 'Dutch'], ['tr', 'Turkish'], ['id', 'Indonesian'], ['ms', 'Malay'], ['th', 'Thai'], ['vi', 'Vietnamese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh-CN', 'Chinese (Simplified)'], ['zh-TW', 'Chinese (Traditional)'], ['ru', 'Russian'], ['pl', 'Polish']];

export default function CategoryPicker({ value, selectedId, country, language, fallback, onChange }) {
  const [catalogue, setCatalogue] = useState(null), [error, setError] = useState('');
  const [open, setOpen] = useState(false), [active, setActive] = useState(-1);
  const root = useRef(null), input = useRef(null), list = useRef(null), id = useId();
  useEffect(() => {
    const controller = new AbortController(); setCatalogue(null); setError('');
    api.get(`/categories${qs({ country, language, all: true })}`, { signal: controller.signal })
      .then(setCatalogue).catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [country, language]);
  const rows = catalogue?.rows || fallback || [];
  const matches = useMemo(() => searchCategories(rows, value), [rows, value]);
  const selected = rows.find(row => row.id === selectedId && categoryKey(row.label) === categoryKey(value))
    || rows.find(row => categoryKey(row.label) === categoryKey(value));
  useEffect(() => { setActive(-1); if (list.current) list.current.scrollTop = 0; }, [value, country, language]);
  useEffect(() => {
    const option = list.current?.querySelector(`[data-index="${active}"]`);
    if (option && list.current) {
      const top = option.offsetTop, bottom = top + option.offsetHeight;
      if (top < list.current.scrollTop) list.current.scrollTop = top;
      else if (bottom > list.current.scrollTop + list.current.clientHeight) list.current.scrollTop = bottom - list.current.clientHeight;
    }
  }, [active]);
  function choose(row) {
    onChange(row.label, row.id); setActive(-1);
    input.current?.focus(); setOpen(false);
  }
  function close() { setOpen(false); setActive(-1); }
  function keyDown(event) {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setOpen(true);
      setActive(index => event.key === 'ArrowDown' ? Math.min(matches.length - 1, index + 1) : Math.max(0, index - 1));
    } else if (event.key === 'Enter' && open) {
      event.preventDefault();
      if (matches[active]) choose(matches[active]);
      else { onChange(value.trim(), selected?.id || null); close(); }
    }
  }
  return <div className="category-picker" ref={root} onBlur={event => { if (!root.current?.contains(event.relatedTarget)) close(); }}>
    <label className="sr-only" htmlFor={`${id}-input`}>Business category</label>
    <div className="category-autocomplete">
      <div className="category-control">
        <Icon name="search" size={17}/>
        <input ref={input} id={`${id}-input`} role="combobox" aria-autocomplete="list" aria-expanded={open}
          aria-controls={open ? `${id}-list` : undefined} aria-activedescendant={open && matches[active] ? `${id}-option-${active}` : undefined}
          aria-describedby={`${id}-hint`} autoComplete="off" maxLength={200} value={value} required
          placeholder="Type a business type, e.g. dentist" onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
          onChange={event => { onChange(event.target.value, null); setOpen(true); }} onKeyDown={keyDown}/>
        {value && <button type="button" className="category-clear" aria-label="Clear business category" onClick={() => { onChange('', null); input.current?.focus(); setOpen(true); }}><Icon name="close" size={15}/></button>}
      </div>
      {open && <div className="category-popover">
        <div className="category-result-count" role="status">{matches.length.toLocaleString()} {matches.length === 1 ? 'category' : 'categories'}{value.trim() ? ' found' : ''}</div>
        <div className="category-options" role="listbox" id={`${id}-list`} aria-label="Suggested business categories" ref={list}>
          {matches.map((row, index) => <div role="option" tabIndex={-1} id={`${id}-option-${index}`} data-index={index} key={row.id}
            aria-selected={selected?.id === row.id} className={active === index ? 'active' : ''}
            onMouseDown={event => event.preventDefault()} onClick={() => choose(row)}>
            <span>{row.label}</span>{selected?.id === row.id && <Icon name="check" size={15}/>}
          </div>)}
          {!matches.length && <div className="category-no-results">No matching category. You can search using your own business type.</div>}
        </div>
        {value.trim() && !selected && <button type="button" className="category-custom" onMouseDown={event => event.preventDefault()}
          onClick={() => choose({ label: value.trim(), id: null })}><Icon name="plus" size={15}/><span>Use “{value.trim()}”</span></button>}
      </div>}
    </div>
    <p className="category-hint" id={`${id}-hint`}>{rows.length.toLocaleString()} categories. Type a keyword or enter your own.</p>
    {error && <p className="hint" role="status">Using built-in categories. {error}</p>}
  </div>;
}
