import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmt, LEAD_STATUSES, webBadge } from '../lib/api.js';
import { ANGLES, fromDateInput, inDays, isDue, pickAngle, renderMessage, shortDate, toDateInput } from '../lib/outreach.js';
import { Icon, IconButton, TierPill } from './ui.jsx';
import ProviderIcon from './ProviderIcon.jsx';
import { useLeadPanelMotion } from './FluidMotion.jsx';
import { getNoteDraft, setNoteDraft, saveNoteDraft } from '../lib/noteDrafts.js';
import '../integrations.css';

const Yes = ({ v, yes = 'Yes', no = 'No' }) => (v == null ? <span className="muted">Not available</span> : <span className={v ? 'ok' : 'bad'}>{v ? yes : no}</span>);

export default function LeadDrawer({ placeId, onClose, onChanged, onDeleted, leadsVersion, notify, settings, onPrev, onNext, position, onComposeEmail, onComposeWhatsApp, onComposeSms }) {
  const [lead, setLead] = useState(null);
  const [notes, setNotes] = useState('');
  const [saved, setSaved] = useState('');
  const dirty = useRef(false);
  const [angle, setAngle] = useState(null);
  const [message, setMessage] = useState('');
  const msgDirty = useRef(false);
  const drawerRef = useRef(null);
  const backdropRef = useRef(null);
  const { dismiss, handlers: dragHandle } = useLeadPanelMotion(drawerRef, backdropRef, onClose);
  const [loadError, setLoadError] = useState('');
  const [messageChannel, setMessageChannel] = useState('whatsapp');
  const [loggingSent, setLoggingSent] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sentSignature, setSentSignature] = useState('');
  const sentRequest = useRef(null);
  const sentInFlight = useRef(false);
  const activePlace = useRef(placeId);
  activePlace.current = placeId;
  const alive = useRef(true);
  const flushNotes = useCallback(id => {
    if (!getNoteDraft(id)) {
      if (alive.current && activePlace.current === id && dirty.current) { dirty.current = false; setSaved('Saved'); }
      return;
    }
    return saveNoteDraft(id, (key, value) => api.patch(`/leads/${key}`, { notes: value })).then(() => {
      if (alive.current && activePlace.current === id && !getNoteDraft(id)) { dirty.current = false; setSaved('Saved'); }
    }).catch(() => {
      if (alive.current && activePlace.current === id) setSaved('Not saved');
      notify('Notes could not be saved. Reopen this lead to retry before refreshing the page.', 'error');
    });
  }, [notify]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const background = [...document.querySelectorAll('.workspace, #app-sidebar, .skip-link')].map(element => ({ element, inert: element.inert }));
    background.forEach(({ element }) => { element.inert = true; });
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      background.forEach(({ element, inert }) => { element.inert = inert; });
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    dirty.current = false;
    msgDirty.current = false;
    setAngle(null);
    setLead(null);
    setSaved('');
    setMessageChannel('whatsapp');
    setSentSignature('');
    sentRequest.current = null;
    if (drawerRef.current) {
      drawerRef.current.scrollTop = 0;
      drawerRef.current.focus({ preventScroll: true });
    }
  }, [placeId]);
  useEffect(() => {
    let off = false;
    setLoadError('');
    api.get(`/leads/${placeId}`).then((l) => {
      if (off) return;
      setLead(l);
      const draft = getNoteDraft(placeId);
      if (draft) { dirty.current = true; setNotes(draft.notes); setSaved('Saving...'); flushNotes(placeId); }
      else if (!dirty.current) setNotes(l.notes);
    }).catch((e) => { if (!off) { setLoadError(e.message); notify(e.message, 'error'); } });
    return () => { off = true; };
  }, [placeId, leadsVersion, notify, flushNotes]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); dismiss(); return; }
      if (e.key === 'Tab') {
        const drawer = drawerRef.current;
        if (!drawer) return;
        const focusable = [...drawer.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')]
          .filter((el) => el.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const current = document.activeElement;
        if (!first) { e.preventDefault(); drawer.focus(); }
        else if (e.shiftKey && (current === first || current === drawer || !drawer.contains(current))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (current === last || current === drawer || !drawer.contains(current))) { e.preventDefault(); first.focus(); }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || document.activeElement?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
      if ((e.key === 'j' || e.key === 'ArrowDown') && onNext) { e.preventDefault(); onNext(); }
      if ((e.key === 'k' || e.key === 'ArrowUp') && onPrev) { e.preventDefault(); onPrev(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismiss, onNext, onPrev]);

  useEffect(() => {
    if (!dirty.current || !getNoteDraft(placeId)) return undefined;
    setSaved('Saving...');
    const t = setTimeout(() => flushNotes(placeId), 700);
    return () => clearTimeout(t);
  }, [notes, placeId, flushNotes]);
  useEffect(() => () => { flushNotes(placeId); }, [placeId, flushNotes]);

  async function setStatus(lead_status) {
    try { setLead(await api.patch(`/leads/${placeId}`, { lead_status })); onChanged(); }
    catch (e) { notify(e.message, 'error'); }
  }
  async function reanalyze() {
    try { setLead(await api.post(`/leads/${placeId}/reanalyze`)); notify('Website queued for re-analysis', 'info'); }
    catch (e) { notify(e.message, 'error'); }
  }
  async function markSent() {
    if (sentInFlight.current || !message.trim()) return;
    const signature = JSON.stringify([placeId, messageChannel, message]);
    if (sentSignature === signature) return;
    if (sentRequest.current?.signature !== signature) sentRequest.current = { signature, key: crypto.randomUUID() };
    sentInFlight.current = true;
    setLoggingSent(true);
    try {
      const result = await api.post(`/previews/${encodeURIComponent(placeId)}/activity`, {
        kind: 'sent', channel: messageChannel, message, idempotencyKey: sentRequest.current.key,
      });
      if (activePlace.current === placeId) {
        setLead(result.lead);
        setSentSignature(signature);
      }
      onChanged();
      notify('Sent message recorded', 'success');
    } catch (e) { notify(e.message, 'error'); }
    finally { sentInFlight.current = false; setLoggingSent(false); }
  }
  async function setFollowUp(ts) {
    try { setLead(await api.patch(`/leads/${placeId}`, { follow_up_at: ts })); onChanged(); }
    catch (e) { notify(e.message, 'error'); }
  }
  async function copyMessage() {
    try { await navigator.clipboard.writeText(message); notify('Message copied', 'success'); }
    catch { notify('Clipboard blocked; select the text and copy it manually', 'error'); }
  }
  async function deleteLead() {
    if (!window.confirm(`Move ${lead.name} to Trash? Scheduled outreach will stop. You can restore the lead later. Previously shared links remain active.`)) return;
    setDeleting(true);
    try { await api.post('/leads/delete', { ids: [placeId], confirmed: true }); onDeleted?.([placeId]); onClose(); notify('Lead moved to Trash', 'success'); }
    catch (e) { notify(e.message, 'error'); }
    finally { setDeleting(false); }
  }

  const activeAngle = angle || (lead ? pickAngle(lead) : 'general');
  useEffect(() => {
    if (lead && !msgDirty.current) setMessage(renderMessage(settings.templates[activeAngle], lead, settings));
  }, [lead, activeAngle, settings]);
  const chooseAngle = (k) => { msgDirty.current = false; setAngle(k); if (lead) setMessage(renderMessage(settings.templates[k], lead, settings)); };

  const site = lead?.site;
  const [webLabel, webTone] = lead ? webBadge(lead) : [];

  return (
    <>
      <div ref={backdropRef} className="backdrop lead-panel-scrim" aria-hidden="true" onClick={dismiss} />
      <aside ref={drawerRef} className="drawer" role="dialog" aria-modal="true" aria-labelledby={lead ? 'lead-detail-title' : undefined} aria-label={lead ? undefined : 'Lead details'} tabIndex={-1}>
        <button className="drawer-grab" type="button" data-no-press aria-label="Close lead details. Drag right or press Enter." title="Drag right to close. Escape also closes this panel." {...dragHandle}><span aria-hidden="true" className="drawer-grip"/><span>Drag right to close</span><Icon name="next" size={13}/></button>
        {!lead ? <>
          <header className="drawer-head"><div className="eyebrow">LEAD DETAILS</div><button className="icon-btn" onClick={dismiss} aria-label="Close lead details"><Icon name="close" /></button></header>
          <div className="loading" role={loadError ? 'alert' : 'status'}>{loadError ? <><strong>Couldn’t load this business</strong><p className="muted small">{loadError}</p><button className="btn" onClick={onChanged}>Try again</button></> : 'Loading business details...'}</div>
        </> : (
          <>
            <header className="drawer-head">
              <div>
                <div className="eyebrow">Lead details{position ? ` / ${position}` : ''}</div>
                <h2 id="lead-detail-title">{lead.name}</h2>
                <p className="muted small">{[lead.category, lead.address].filter(Boolean).join(' · ')}</p>
                <div className="drawer-tags"><TierPill tier={lead.tier} score={lead.score} /><span className={`badge ${webTone}`}>{webLabel}</span></div>
              </div>
              <div className="flex shrink-0 items-start gap-1">
                <button className="icon-btn disabled:opacity-35" onClick={onPrev} disabled={!onPrev} aria-label="Previous lead" title="Previous lead (K)"><Icon name="arrowUp" /></button>
                <button className="icon-btn disabled:opacity-35" onClick={onNext} disabled={!onNext} aria-label="Next lead" title="Next lead (J)"><Icon name="arrowDown" /></button>
                <button className="icon-btn" onClick={dismiss} aria-label="Close lead details" title="Close (Esc)"><Icon name="close" /></button>
              </div>
            </header>
            <div className="quick" aria-label="Contact actions">
              {onComposeEmail && <button className="btn primary" onClick={() => onComposeEmail(lead, message, `A homepage idea for ${lead.name}`)}><Icon name="mail" size={15} />Email</button>}
              {(lead.whatsapp || lead.phone_e164) && onComposeWhatsApp && <button type="button" className="btn drawer-whatsapp" title="Open WhatsApp composer in Local Geni" onClick={() => onComposeWhatsApp([placeId], message)}><ProviderIcon provider="whatsapp" size={17}/>WhatsApp</button>}
              {lead.phone_e164 && onComposeSms && <button type="button" className="btn drawer-sms" title="Open SMS composer in Local Geni" onClick={() => onComposeSms(lead)}><Icon name="sms" size={16}/>SMS</button>}
              {lead.phone_e164 && <a className="ci" title="Call" aria-label={`Call ${lead.phone_e164}`} href={`tel:${lead.phone_e164}`}><Icon name="phone" size={16}/></a>}
              {lead.website && <a className="ci website" title="Visit website" aria-label={`Visit ${lead.name} website`} href={lead.website} target="_blank" rel="noreferrer"><Icon name="globe" size={16}/></a>}
              <IconButton className="drawer-delete" icon="trash" label="Move lead to Trash" disabled={deleting} onClick={deleteLead}/>
            </div>

            <section className="d-sec drawer-outreach">
              <div className="sec-head"><h4><Icon name="message" size={16}/>Outreach message</h4><IconButton icon="copy" label="Copy outreach message" onClick={copyMessage}/></div>
              <label className="drawer-approach"><span>Message approach</span><select value={activeAngle} onChange={event => chooseAngle(event.target.value)}>{ANGLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
              <textarea rows={6} maxLength={10000} aria-label="Outreach message" value={message} onChange={(e) => { msgDirty.current = true; setMessage(e.target.value); }} />
              <small className="muted drawer-helper">
                {(lead.whatsapp || lead.phone_e164) ? 'Opens an in-app review first. Nothing is sent until you explicitly open the chat and press send.' : 'No WhatsApp number; copy the message or use email.'}
              </small>
              <details className="drawer-record">
              <summary><Icon name="check" size={14}/>Record a sent message<Icon name="next" size={14}/></summary>
              <p className="drawer-helper muted">For messages sent outside Local Geni. Emails sent here are recorded automatically when accepted.</p>
              <div className="drawer-record-row">
                <label className="field"><span>Sent through</span><select value={messageChannel} onChange={(e) => setMessageChannel(e.target.value)} disabled={loggingSent}>
                  <option value="whatsapp">WhatsApp</option><option value="email">Email</option><option value="other">Other</option>
                </select></label>
                <button className="btn" onClick={markSent} disabled={loggingSent || !message.trim() || sentSignature === JSON.stringify([placeId, messageChannel, message])}>
                  {loggingSent ? 'Recording...' : sentSignature === JSON.stringify([placeId, messageChannel, message]) ? 'Sent recorded' : 'Mark as sent'}
                </button>
              </div>
              </details>
            </section>

            <section className="d-sec drawer-relationship">
              <div className="sec-head"><h4><Icon name="person" size={16}/>Relationship</h4><select className={`drawer-status s-${lead.lead_status}`} aria-label="Contact status" value={lead.lead_status} onChange={event => setStatus(event.target.value)}>{LEAD_STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
              <div className="drawer-followup">
                <label className="field"><span><Icon name="calendar" size={14}/>Follow up</span><input type="date" value={toDateInput(lead.follow_up_at)} onChange={(e) => setFollowUp(fromDateInput(e.target.value))}/></label>
                <div className="drawer-date-options">
                {[['Tomorrow', 1], ['+3 days', 3], ['+1 week', 7]].map(([l, n]) => (
                  <button key={l} className="btn xs" onClick={() => setFollowUp(inDays(n))}>{l}</button>
                ))}
                {lead.follow_up_at && <IconButton icon="close" label="Clear follow-up date" onClick={() => setFollowUp(null)}/>}
                </div>
              </div>
              {(lead.follow_up_at || lead.last_contacted_at) && (
                <div className="flex flex-wrap gap-x-3 text-xs">
                  {lead.follow_up_at && <span className={isDue(lead.follow_up_at) ? 'font-semibold text-hot' : 'text-muted'}>{isDue(lead.follow_up_at) ? 'Due' : 'Scheduled'} {shortDate(lead.follow_up_at)}</span>}
                  {lead.last_contacted_at && <span className="text-muted">Last contacted {fmt.ago(lead.last_contacted_at)}</span>}
                </div>
              )}
              <textarea rows={3} aria-label="Notes about this business" placeholder="Add a conversation note…" value={notes}
                onChange={(e) => { dirty.current = true; setNoteDraft(placeId, e.target.value); setNotes(e.target.value); }} />
              <small className="muted" role="status">{saved || 'Notes save automatically.'}</small>
              {saved === 'Not saved' && <button className="btn xs" onClick={() => { setSaved('Saving...'); flushNotes(placeId); }}><Icon name="refresh" size={14}/>Retry saving notes</button>}
            </section>

            {lead.reasons.length > 0 && <details className="d-sec drawer-details">
              <summary><Icon name="chart" size={16}/><span>Priority score</span><small>{lead.score} points</small><Icon name="next" size={15}/></summary>
              <ul className="reasons">
                {lead.reasons.map((r) => (
                  <li key={r.label} className={r.points > 0 ? 'plus' : r.points < 0 ? 'minus' : 'zero'}>
                    <span className="num">{r.points > 0 ? `+${r.points}` : r.points}</span>{r.label}
                  </li>
                ))}
              </ul>
            </details>}

            <details className="d-sec drawer-details" open>
              <summary><Icon name="leads" size={16}/><span>Contact details</span><Icon name="next" size={15}/></summary>
              <dl className="kv">
                <dt>Phone</dt><dd>{lead.phone_intl || lead.phone_e164 || <span className="muted">Not on Google</span>} {lead.phone_type && <small className="muted">({lead.phone_type.toLowerCase().replace(/_/g, ' ')})</small>}</dd>
                <dt>WhatsApp</dt><dd>{lead.whatsapp
                  ? <>{lead.whatsapp} <small className={lead.whatsapp_source === 'website' ? 'ok' : 'muted'}>{lead.whatsapp_source === 'website' ? 'published on website' : 'mobile number; not verified'}</small></>
                  : <span className="muted">Not found</span>}</dd>
                <dt>Email</dt><dd>{lead.emails.length ? lead.emails.join(', ') : <span className="muted">{lead.site_status === 'ok' ? 'None published on site' : 'Not available (no analysable website)'}</span>}</dd>
                <dt>Social</dt><dd>{Object.keys(lead.socials).length
                  ? Object.entries(lead.socials).map(([k, u]) => <a key={k} className="tag-link" href={u} target="_blank" rel="noreferrer">{k}</a>)
                  : <span className="muted">None found</span>}</dd>
              </dl>
            </details>

            <details className="d-sec drawer-details">
              <summary><Icon name="globe" size={16}/><span>Website analysis</span><small>{webLabel}</small><Icon name="next" size={15}/></summary>
              {lead.website && <button className="btn drawer-reanalyse" onClick={reanalyze}><Icon name="refresh" size={14}/>Re-analyse</button>}
              {!lead.website && <p className="muted">No website on the Google listing.</p>}
              {lead.website && !site && <p className="muted">Analysis pending...</p>}
              {site && (
                <>
                  {site.reason && <p className="note">{site.reason}</p>}
                  <dl className="kv">
                    <dt>URL</dt><dd className="break">{site.finalUrl || lead.website}</dd>
                    <dt>Reachable</dt><dd>{site.status === 'ok' ? <span className="ok">Yes (HTTP {site.httpCode})</span> : site.status === 'unknown' ? <span className="muted">Could not verify</span> : site.status === 'social_only' ? <span className="bad">Not an own website</span> : <span className="bad">No</span>}</dd>
                    {site.status === 'ok' && (
                      <>
                        <dt>HTTPS</dt><dd><Yes v={site.https} /> {site.httpsNote && <small className="muted">{site.httpsNote}</small>}</dd>
                        <dt>Speed</dt><dd>{site.speed} <small className="muted">{site.responseMs} ms HTML fetch / {site.htmlKb} KB (not Lighthouse)</small></dd>
                        <dt>Mobile</dt><dd>{site.mobile.verdict === 'likely' ? <span className="ok">Likely responsive</span> : <span className="bad">Likely not responsive</span>} <small className="muted">viewport meta {site.mobile.viewportMeta ? 'present' : 'missing'}</small></dd>
                        <dt>Design</dt><dd><span className={site.design.verdict === 'modern' ? 'ok' : 'bad'}>{site.design.verdict}</span>{site.design.generator && <small className="muted"> / {site.design.generator}</small>}</dd>
                        <dt>Clear CTA</dt><dd><Yes v={site.cta.clear} /> <small className="muted">{[site.cta.phoneLink && 'tel link', site.cta.whatsappLink && 'WhatsApp', site.cta.contactForm && 'form', site.cta.contactPage && 'contact page'].filter(Boolean).join(', ') || 'none detected'}</small></dd>
                        <dt>Booking / ordering</dt><dd><Yes v={site.booking.detected} yes="Detected" no="Not detected" /> {site.booking.evidence && <small className="muted">“{site.booking.evidence}”</small>}</dd>
                      </>
                    )}
                  </dl>
                  {site.design?.signals?.length > 0 && (
                    <ul className="signals">{site.design.signals.map((s) => <li key={s.label}>{s.label}</li>)}</ul>
                  )}
                  <details className="not-measured">
                    <summary>What this check does not measure</summary>
                    <ul>{(site.notMeasured || []).map((t) => <li key={t}>{t}</li>)}</ul>
                  </details>
                  <small className="muted">Checked {fmt.ago(site.checkedAt)}</small>
                </>
              )}
            </details>

            <details className="d-sec drawer-details">
              <summary><Icon name="mapPin" size={16}/><span>Google listing</span>{lead.rating > 0 && <small>{lead.rating} / 5 · {fmt.num(lead.review_count)} reviews</small>}<Icon name="next" size={15}/></summary>
              <dl className="kv">
                <dt>Rating</dt><dd>{lead.rating ? `${lead.rating} out of 5 from ${fmt.num(lead.review_count)} reviews` : <span className="muted">No rating</span>}</dd>
                <dt>Status</dt><dd>{(lead.business_status || 'unknown').toLowerCase().replace(/_/g, ' ')}{lead.open_now != null && <small className="muted"> / {lead.open_now ? 'open now' : 'closed now'}</small>}</dd>
                <dt>Hours</dt><dd>{lead.hours?.length ? <ul className="hours">{lead.hours.map((h) => <li key={h}>{h}</li>)}</ul> : <span className="muted">Not available</span>}</dd>
                <dt>Place ID</dt><dd className="mono break">{lead.place_id}</dd>
                <dt>Seen</dt><dd>first {fmt.ago(lead.first_seen)} / last {fmt.ago(lead.last_seen)}</dd>
              </dl>
            </details>
          </>
        )}
      </aside>
    </>
  );
}
