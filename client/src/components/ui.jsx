import { cloneElement, isValidElement, useId, useState } from 'react';
import { Grid2X2, Crosshair } from 'lucide-react';
import { TIER_LABEL, fmt } from '../lib/api.js';

import { Plug, CalendarDays, Building2, UserRound, List, ArrowUpRight, Search, Compass, Activity, ContactRound, ChartNoAxesCombined, Download, MessageSquare, SlidersHorizontal, PanelLeft, LockKeyhole, Plus, PanelsTopLeft, Image, Link, X, ArrowUp, ArrowDown, Check, CircleAlert, Phone, Mail, MapPin, Globe, RefreshCw, Play, Settings2, Unplug, ExternalLink, Send, Trash2, ArchiveRestore, ChevronLeft, ChevronRight, ChevronDown, Info, KeyRound, Eye, EyeOff, Smartphone, ShieldCheck, LoaderCircle, Sparkles, Upload, FileSpreadsheet, ClipboardPaste, Pencil, Archive, Pause, Copy, Clock3, Trophy, FileCode2, LogOut } from 'lucide-react';

const ICONS = { plug: Plug, calendar: CalendarDays, building: Building2, person: UserRound, list: List, arrowUpRight: ArrowUpRight, search: Search, compass: Compass, activity: Activity, leads: ContactRound, chart: ChartNoAxesCombined, download: Download, message: MessageSquare, settings: SlidersHorizontal, sidebar: PanelLeft, lock: LockKeyhole, plus: Plus, design: PanelsTopLeft, image: Image, link: Link, close: X, arrowUp: ArrowUp, arrowDown: ArrowDown, check: Check, alert: CircleAlert, phone: Phone, mail: Mail, map: MapPin, mapPin: MapPin, globe: Globe, refresh: RefreshCw, play: Play, manage: Settings2, disconnect: Unplug, external: ExternalLink, send: Send, trash: Trash2, restore: ArchiveRestore, previous: ChevronLeft, next: ChevronRight, chevronDown: ChevronDown, info: Info, key: KeyRound, eye: Eye, eyeOff: EyeOff, sms: Smartphone, shield: ShieldCheck, loading: LoaderCircle, sparkles: Sparkles, upload: Upload, spreadsheet: FileSpreadsheet, paste: ClipboardPaste, edit: Pencil, archive: Archive, pause: Pause };

Object.assign(ICONS, { copy: Copy, clock: Clock3, trophy: Trophy, codeFile: FileCode2, signOut: LogOut, grid: Grid2X2, target: Crosshair });

export function Icon({ name, size = 20, ...props }) {
  const Glyph = ICONS[name] || Compass;
  return <Glyph size={size} strokeWidth={1.7} aria-hidden="true" focusable="false" {...props} />;
}

export function IconButton({ icon, label, className = '', size = 16, ...props }) {
  return <button type="button" className={`ci ${className}`.trim()} aria-label={label} title={label} {...props}><Icon name={icon} size={size}/></button>;
}

const STATUS_LABELS = { running: 'Running', paused: 'Paused', interrupted: 'Interrupted', failed: 'Failed', completed: 'Completed', pending: 'Pending' };
const humanize = value => String(value || 'unknown').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());

export const StatusChip = ({ status }) => {
  const label = STATUS_LABELS[status] || humanize(status);
  return <span className={`chip st-${status || 'unknown'}`} role="status" aria-label={`Status: ${label}`}>{label}</span>;
};

export const TierPill = ({ tier, score }) => (
  <span className={`tier tier-${tier || 'unknown'}`} aria-label={`${TIER_LABEL[tier] || humanize(tier)}${score != null ? `, score ${score}` : ''}`}>
    {TIER_LABEL[tier] || humanize(tier)}{score != null && <b className="num">{score}</b>}
  </span>
);

export function Meter({ label, value, max, hint, tone }) {
  const pct = Math.min(100, Math.round(((value || 0) / Math.max(max || 0, 1)) * 100));
  const hintId = hint ? `meter-hint-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : undefined;
  return (
    <div className="meter">
      <div className="meter-top"><span>{label}</span><span className="num">{fmt.num(value)} / {fmt.num(max)}</span></div>
      <div className="meter-track" role="meter" aria-label={label} aria-describedby={hintId} aria-valuenow={value || 0} aria-valuemin={0} aria-valuemax={Math.max(max || 0, value || 0, 1)}><div className={`meter-fill ${tone || ''}`} style={{ width: `${pct}%` }} /></div>
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  );
}

export const Kpi = ({ label, value, sub, tone }) => (
  <div className={`kpi ${tone || ''}`}>
    <span>{label}</span>
    <strong className="num">{value}</strong>
    {sub && <small>{sub}</small>}
  </div>
);

export function MetricStrip({ items, label, className = '' }) {
  return <dl className={`metric-strip ${className}`} aria-label={label} style={{ '--metric-columns': items.length }}>
    {items.map(item => <div key={item.label} className={`metric-item ${item.tone || ''}`}>
      <dt><span className="metric-symbol"><Icon name={item.icon} size={15}/></span>{item.label}</dt>
      <dd><strong>{item.value}</strong>{item.sub && <small>{item.sub}</small>}</dd>
    </div>)}
  </dl>;
}

export const Empty = ({ title, children }) => (
  <div className="empty"><span className="empty-icon"><Icon name="search" size={25} /></span><h3>{title}</h3>{children}</div>
);

export const PageHead = ({ eyebrow, title, description, children }) => (
  <header className="page-head">
    <div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>
    {children && <div className="page-actions">{children}</div>}
  </header>
);

const describedBy = (...ids) => ids.filter(Boolean).join(' ') || undefined;

export function Button({ variant = '', size = '', icon, className = '', children, type = 'button', ...props }) {
  return <button type={type} className={`btn ${variant} ${size} ${className}`.replace(/\s+/g, ' ').trim()} {...props}>
    {icon && <Icon name={icon} size={size === 'xs' ? 15 : 17} />}{children}
  </button>;
}

export function ValidationMessage({ id, children, className = '', role = 'alert' }) {
  if (!children) return null;
  return <p id={id} className={`ui-validation-message ${className}`.trim()} role={role}>{children}</p>;
}

export function Field({ id: providedId, label, hint, error, required = false, className = '', children, ...props }) {
  const generatedId = useId().replaceAll(':', '');
  const id = providedId || `field-${generatedId}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const control = isValidElement(children) ? cloneElement(children, {
    id: children.props.id || id,
    required: required || children.props.required,
    'aria-describedby': describedBy(children.props['aria-describedby'], hintId, errorId),
    'aria-invalid': error ? true : children.props['aria-invalid'],
    'aria-errormessage': error ? errorId : children.props['aria-errormessage'],
  }) : children;
  const controlId = isValidElement(control) ? control.props.id || id : id;
  return <div className={`ui-field ${className}`.trim()} {...props}>
    <label htmlFor={controlId}>{label}{required && <span className="ui-required" aria-hidden="true"> *</span>}</label>
    {control}
    {hint && <p id={hintId} className="ui-hint">{hint}</p>}
    {error && <ValidationMessage id={errorId}>{error}</ValidationMessage>}
  </div>;
}

export function TextField({ label, hint, error, required = false, className = '', ...props }) {
  return <Field label={label} hint={hint} error={error} required={required} className={className}>
    <input {...props} />
  </Field>;
}

export function SelectField({ label, hint, error, required = false, options = [], className = '', children, ...props }) {
  return <Field label={label} hint={hint} error={error} required={required} className={className}>
    <select {...props}>{children || options.map(([value, optionLabel]) => <option key={value} value={value}>{optionLabel}</option>)}</select>
  </Field>;
}

function ChoiceField({ type, id: providedId, label, hint, error, required = false, className = '', ...props }) {
  const generatedId = useId().replaceAll(':', '');
  const id = providedId || `choice-${generatedId}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return <div className={`ui-choice-field ${className}`.trim()}>
    <label htmlFor={id}><input {...props} id={id} type={type} required={required} aria-describedby={describedBy(hintId, errorId)} aria-invalid={Boolean(error)} aria-errormessage={error ? errorId : undefined} /><span>{label}{required && <span className="ui-required" aria-hidden="true"> *</span>}</span></label>
    {hint && <p id={hintId} className="ui-hint">{hint}</p>}
    {error && <ValidationMessage id={errorId}>{error}</ValidationMessage>}
  </div>;
}

export function CheckboxField(props) { return <ChoiceField type="checkbox" {...props} />; }
export function RadioField(props) { return <ChoiceField type="radio" {...props} />; }

export function Badge({ tone = 'neutral', className = '', children, ...props }) {
  return <span className={`ui-badge ${tone} ${className}`.replace(/\s+/g, ' ').trim()} {...props}>{children}</span>;
}

export function Tabs({ tabs = [], value, onChange, ariaLabel, className = '', id: providedId }) {
  const generatedId = useId().replaceAll(':', '');
  const id = providedId || `tabs-${generatedId}`;
  const selectedIndex = Math.max(0, tabs.findIndex(tab => (tab.value ?? tab.id) === value));
  const focusTab = index => {
    const next = (index + tabs.length) % tabs.length;
    onChange?.(tabs[next]?.value ?? tabs[next]?.id);
    requestAnimationFrame(() => document.getElementById(`${id}-tab-${next}`)?.focus());
  };
  return <div className={`ui-tabs ${className}`.trim()} role="tablist" aria-label={ariaLabel}>
    {tabs.map((tab, index) => {
      const selected = index === selectedIndex;
      const panelId = tab.panelId || (tab.panel ? `${id}-panel-${index}` : undefined);
      return <button key={tab.id || tab.value || index} id={`${id}-tab-${index}`} type="button" role="tab" aria-selected={selected} aria-controls={panelId} tabIndex={selected ? 0 : -1} onClick={() => onChange?.(tab.value ?? tab.id)} onKeyDown={event => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); focusTab(index + 1); }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); focusTab(index - 1); }
        if (event.key === 'Home') { event.preventDefault(); focusTab(0); }
        if (event.key === 'End') { event.preventDefault(); focusTab(tabs.length - 1); }
      }}>{tab.icon && <Icon name={tab.icon} size={15} />}{tab.label}{tab.count != null && <span className="ui-tab-count">{fmt.num(tab.count)}</span>}</button>;
    })}
  </div>;
}

export function Dialog({ open, onClose, title, description, ariaLabel, className = '', children }) {
  const titleId = useId().replaceAll(':', '');
  const descriptionId = description ? `${titleId}-description` : undefined;
  if (!open) return null;
  return <div className="ui-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose?.(); }}>
    <section className={`ui-dialog ${className}`.trim()} role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} aria-label={title ? undefined : ariaLabel} aria-describedby={descriptionId}>
      {(title || onClose) && <header>{title && <div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId} className="ui-hint">{description}</p>}</div>}{onClose && <IconButton icon="close" label={`Close ${title || 'dialog'}`} onClick={onClose} />}</header>}
      <div className="ui-dialog-body">{children}</div>
    </section>
  </div>;
}

export function Popover({ open, role = 'dialog', className = '', children, ...props }) {
  if (!open) return null;
  return <div className={`ui-popover ${className}`.trim()} role={role} {...props}>{children}</div>;
}

export function DataTable({ caption, className = '', children, ...props }) {
  return <div className="ui-table-wrap"><table className={`table ${className}`.trim()} {...props}>{caption && <caption className="sr-only">{caption}</caption>}{children}</table></div>;
}

export function Tooltip({ label, className = '', children, ...props }) {
  const id = `tooltip-${useId().replaceAll(':', '')}`;
  return <span className={`ui-tooltip ${className}`.trim()} aria-describedby={id} {...props}>{children}<span id={id} role="tooltip">{label}</span></span>;
}

/** Horizontal bar list for small categorical breakdowns. Rows become buttons when onSelect is given. */
export function Bars({ rows = [], labels = {}, tones = {}, onSelect }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  if (!rows.length) return <p className="muted small">No data yet.</p>;
  return (
    <ul className="bars">
      {rows.map((r) => {
        const label = labels[r.k] || r.k || '-';
        const cells = (
          <>
            <span className="bars-label">{label}</span>
            <span className="bars-track"><span className={`bars-fill ${tones[r.k] || ''}`} style={{ width: `${(r.n / max) * 100}%` }} /></span>
            <span className="num bars-n">{fmt.num(r.n)}</span>
          </>
        );
        return (
          <li key={String(r.k)} className={onSelect ? undefined : 'bars-row'}>
            {onSelect ? (
              <button
                type="button"
                className="bars-row -mx-1.5 w-[calc(100%+0.75rem)] cursor-pointer rounded-md px-1.5 py-0.5 text-left hover:bg-panel-2 hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
                title={`Show ${fmt.num(r.n)} ${label} leads`}
                onClick={() => onSelect(r.k)}
              >
                {cells}
              </button>
            ) : cells}
          </li>
        );
      })}
    </ul>
  );
}

/** Password field with a show/hide toggle. */
export function PasswordInput({ value, onChange, autoComplete, placeholder, required, className = '', ...props }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative block">
      <input {...props} type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete}
        placeholder={placeholder} required={required} className={`${className} !pr-16`.trim()} />
      <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'}
        className="absolute top-1/2 right-1.5 h-7 -translate-y-1/2 cursor-pointer rounded-md px-2 text-xs text-muted hover:bg-panel-2 hover:text-ink">
        <Icon name={show ? 'eyeOff' : 'eye'} size={16}/>
      </button>
    </span>
  );
}

/**
 * Tab bar for one filter dimension. tabs: [{ value, label, icon, n }] where value '' means "all".
 * variant 'underline' for the primary row, 'pill' for secondary rows.
 */
export function FilterTabs({ tabs, value, onChange, variant = 'underline', ariaLabel, className = '' }) {
  const pill = variant === 'pill';
  return (
    <div role="group" aria-label={ariaLabel} className={`${pill ? 'flex flex-wrap items-center gap-1.5' : 'flex flex-wrap items-end gap-1 border-b border-line'} ${className}`.trim()}>
      {tabs.map((t) => {
        const on = value === t.value;
        const look = pill
          ? `h-8 rounded-full border px-3 ${on ? 'border-ink bg-ink text-white' : 'border-line bg-panel text-ink-2 hover:border-[#cfcabe] hover:text-ink'}`
          : `-mb-px rounded-t-lg border px-3.5 py-2 ${on ? 'border-line border-b-panel bg-panel font-semibold text-ink' : 'border-transparent text-ink-2 hover:bg-panel/60 hover:text-ink'}`;
        return (
          <button key={t.value || 'all'} type="button" aria-pressed={on} onClick={() => onChange(t.value)}
            className={`flex cursor-pointer items-center gap-1.5 text-[13px] ${look}`}>
            {t.icon && <span className="text-base leading-none">{t.icon}</span>}
            {t.label}
            <span className={`rounded-full px-1.5 text-[11px] leading-[18px] tabular-nums ${on ? (pill ? 'bg-white/20 text-white' : 'bg-ink text-white') : 'bg-line-2 text-muted'}`}>
              {fmt.num(t.n)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
