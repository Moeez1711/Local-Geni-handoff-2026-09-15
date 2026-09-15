import { useEffect, useState } from 'react';
import { api, fmt } from '../lib/api.js';
import { Icon, Meter, PageHead } from './ui.jsx';

const LIMIT_FIELDS = [
  { k: 'monthlySearchLimit', label: 'Monthly search limit', unit: '/ month', hint: '0 = unlimited' },
  { k: 'dailySearchLimit', label: 'Daily search limit', unit: '/ day', hint: '0 = unlimited' },
  { k: 'defaultScanBudget', label: 'Searches per scan', unit: 'searches', hint: '' },
  { k: 'defaultTargetCount', label: 'Leads per scan', unit: 'leads', hint: '' },
  { k: 'cacheHours', label: 'Reuse searches', unit: 'hours', hint: '0 = no reuse' },
];
const PRICING_FIELDS = [
  { k: 'freeSearchesPerMonth', label: 'Free searches per month', unit: 'searches', hint: 'Confirm in Google billing' },
  { k: 'costPer1000', label: 'Price per 1,000', unit: 'USD / 1,000', hint: 'Estimate only', step: '0.01' },
];
const PRESETS = [
  ['1,000 / month', { monthlySearchLimit: 1000, dailySearchLimit: 33 }],
  ['1,500 / month', { monthlySearchLimit: 1500, dailySearchLimit: 50 }],
  ['3,000 / month', { monthlySearchLimit: 3000, dailySearchLimit: 100 }],
  ['No limits', { monthlySearchLimit: 0, dailySearchLimit: 0 }],
];

function Field({ f, value, onChange }) {
  return (
    <label className="limit-field">
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold text-ink">{f.label}</span>
        {f.hint && <small className="text-muted">{f.hint}</small>}
      </span>
      <span className="limit-input">
        <input type="number" min="0" step={f.step || '1'} value={value} onChange={onChange} className="text-right tabular-nums" />
        <span className="limit-unit">{f.unit}</span>
      </span>
    </label>
  );
}

export default function SettingsPage({ notify, onDirtyChange, onBusyChange }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const dirty = Boolean(data && draft && JSON.stringify(draft) !== JSON.stringify(data.limits));
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(saving); return () => onBusyChange?.(false); }, [saving, onBusyChange]);

  const load = () => api.get('/limits').then((u) => { setData(u); setDraft(u.limits); });
  useEffect(() => { load().catch((e) => notify(e.message, 'error')); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data || !draft) return <div className="loading">Loading...</div>;

  const set = (k) => (e) => setDraft({ ...draft, [k]: e.target.value === '' ? '' : Number(e.target.value) });
  const costAt = (limit) => (Number(limit) > 0 ? (Math.max(0, Number(limit) - Number(draft.freeSearchesPerMonth || 0)) * Number(draft.costPer1000 || 0)) / 1000 : null);
  const { searches: s, limits: l, remaining } = data;
  const worst = costAt(draft.monthlySearchLimit);

  async function save() {
    setSaving(true);
    try {
      const u = await api.put('/limits', draft);
      setData(u); setDraft(u.limits);
      notify('Search limits saved', 'success');
    } catch (e) { notify(e.message, 'error'); }
    finally { setSaving(false); }
  }

  return (
    <div className="page limits-page">
      <PageHead eyebrow="07 / Settings" title="Search limits">
        <button className="ci" disabled={saving} title="Refresh limits" aria-label="Refresh limits" onClick={() => { if (!dirty || window.confirm('Discard unsaved limits?')) load().catch(e => notify(e.message, 'error')); }}><Icon name="refresh" size={16}/></button>
        <button className="ci" disabled={!dirty || saving} title="Discard changes" aria-label="Discard changes" onClick={() => setDraft(data.limits)}><Icon name="close" size={16}/></button>
        <button className="btn primary" disabled={!dirty || saving} onClick={save}><Icon name="check" size={15}/>{saving ? 'Saving…' : 'Save'}</button>
      </PageHead>

      <section className="card limit-usage">
        <Meter label="This month" value={s.month} max={l.monthlySearchLimit || Math.max(s.month, l.freeSearchesPerMonth)}
          tone={l.monthlySearchLimit && s.month >= l.monthlySearchLimit * 0.85 ? 'warn' : 'accent'}
          hint={l.monthlySearchLimit ? `${fmt.num(remaining.month)} remaining` : 'No monthly limit; bar shows the free allowance'} />
        {l.dailySearchLimit ? <Meter label="Today" value={s.today} max={l.dailySearchLimit}
          tone={l.dailySearchLimit && s.today >= l.dailySearchLimit * 0.85 ? 'warn' : 'accent'}
          hint={`${fmt.num(remaining.today)} left today`} /> : <div className="flex flex-col gap-0.5"><span className="text-xs font-semibold text-ink-2">Today</span><strong className="text-2xl font-semibold tabular-nums">{fmt.num(s.today)}</strong><small className="text-muted">No daily limit</small></div>}
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-semibold text-ink-2">Estimated monthly cost</span>
          <strong className={`text-2xl font-semibold tabular-nums ${data.estMonthCostUsd > 0 ? 'text-hot' : 'text-good'}`}>${data.estMonthCostUsd.toFixed(2)}</strong>
          <small className="text-muted">Based on your configured rates</small>
        </div>
      </section>

      <section className="limit-presets" aria-label="Search presets">
        
        {PRESETS.map(([label, values]) => {
          const on = draft.monthlySearchLimit === values.monthlySearchLimit && draft.dailySearchLimit === values.dailySearchLimit;
          const c = costAt(values.monthlySearchLimit);
          return (
            <button key={label} type="button" className={`chip-btn ${on ? 'on' : ''}`} aria-pressed={on} disabled={saving} title={values.monthlySearchLimit ? `${values.dailySearchLimit}/day · Estimated $${c.toFixed(2)}/month` : 'No monthly or daily cap'} onClick={() => setDraft({ ...draft, ...values })}>
              {label}
            </button>
          );
        })}
        <span className={`ml-auto text-xs ${worst == null ? 'font-semibold text-hot' : 'text-muted'}`}>
          {worst == null ? 'No spending cap' : `Estimate at cap: $${worst.toFixed(2)}/month`}
        </span>
      </section>

      <div className="limit-settings-grid">
        <section className="card limit-settings">
          <div className="card-head !mb-0"><h3><Icon name="settings" size={17}/>Limits</h3>{dirty && <span className="limit-dirty" title="Unsaved changes" aria-label="Unsaved changes"/>}</div>
          {LIMIT_FIELDS.map((f) => <Field key={f.k} f={f} value={draft[f.k]} onChange={set(f.k)} />)}
        </section>
        <section className="card limit-settings">
          <div className="card-head !mb-0"><h3><Icon name="chart" size={17}/>Cost estimates</h3></div>
          {PRICING_FIELDS.map((f) => <Field key={f.k} f={f} value={draft[f.k]} onChange={set(f.k)} />)}
          <details className="integration-help"><summary>How limits work</summary><p className="hint"> Before every billed Google search the server checks these limits. When one is reached the
            running scan pauses with a message; resume it after raising the limit, or the next day/month. Starting a scan is blocked while you are at a limit.
            Reused (cached) searches, website checks and exports never count. Area lookups and map loads have separate, larger free allowances and are not capped here.
            For a guarantee enforced by Google itself, also set a quota in Cloud Console / Places API (New) / Quotas.
          </p></details>
        </section>
      </div>
    </div>
  );
}
