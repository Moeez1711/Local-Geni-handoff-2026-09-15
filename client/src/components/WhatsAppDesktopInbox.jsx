import { useEffect, useRef, useState } from 'react';
import ProviderIcon from './ProviderIcon.jsx';
import '../whatsapp-desktop.css';

const desktop = window.localGeniDesktop?.version === 1 ? window.localGeniDesktop.whatsapp : null;

export default function WhatsAppDesktopInbox({ onOpenApi }) {
  const surface = useRef(null);
  const [status, setStatus] = useState({ phase: 'idle', error: '' });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    if (!desktop) return undefined;
    let disposed = false;
    let frame = 0;
    let last = '';
    const receive = next => { if (!disposed) setStatus(next); };
    const unsubscribe = desktop.onStatus(receive);
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed || !surface.current) return;
        const rect = surface.current.getBoundingClientRect();
        // Native views sit above DOM overlays. Hide beneath any open app dialog.
        const blocked = document.querySelector('[role="dialog"], [aria-modal="true"], dialog[open]');
        const layout = {
          visible: !document.hidden && !blocked && rect.width > 0 && rect.height > 0,
          x: Math.max(0, rect.left), y: Math.max(0, rect.top),
          width: Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(0, rect.left)),
          height: Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(0, rect.top)),
        };
        const signature = JSON.stringify(layout);
        if (signature !== last) { last = signature; desktop.setBounds(layout); }
      });
    };
    const resize = new ResizeObserver(sync);
    resize.observe(surface.current);
    const mutations = new MutationObserver(sync);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'aria-modal', 'role'] });
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    document.addEventListener('visibilitychange', sync);
    // Also follow sidebar transitions and changes to the surrounding layout.
    const timer = setInterval(sync, 300);
    desktop.open().then(receive).catch(error => {
      if (!disposed) setActionError(error.message || 'The desktop inbox could not be opened.');
    });
    sync();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      clearInterval(timer);
      resize.disconnect();
      mutations.disconnect();
      unsubscribe();
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
      document.removeEventListener('visibilitychange', sync);
      desktop.hide();
    };
  }, []);

  async function run(action) {
    if (busy) return;
    if (action === 'reload' && !window.confirm('Reload WhatsApp? Finish or copy any unsent message first.')) return;
    setBusy(true);
    setActionError('');
    try { setStatus(await desktop[action]()); }
    catch (error) { setActionError(error.message || 'That action could not be completed.'); }
    finally { setBusy(false); }
  }

  if (!desktop) return <section className="wa-desktop-intro card">
    <div className="wa-desktop-intro-icon"><ProviderIcon provider="whatsapp" size={30} /></div>
    <h2>Personal chats need Desktop</h2>
    <button className="btn" type="button" onClick={onOpenApi}>Open business inbox</button>
    <details className="integration-help"><summary>Desktop setup</summary><ol className="wa-desktop-steps">
      <li><strong>Open Local Geni Desktop</strong><span>Use the launcher or run <code>npm run desktop</code>.</span></li>
      <li><strong>Scan the QR code</strong><span>On your phone: WhatsApp / Linked devices / Link a device</span></li>
    </ol></details>
  </section>;

  return <section className="wa-desktop-inbox" aria-label="WhatsApp inbox">
    <header className="wa-desktop-toolbar">
      <div><span className="wa-desktop-state" role="status">{status.phase === 'ready' ? 'WhatsApp Web' : status.phase === 'error' ? 'Needs attention' : status.phase === 'resetting' ? 'Signing out...' : 'Opening...'}</span></div>
      <div className="wa-desktop-actions"><button className="btn" disabled={busy || status.phase === 'resetting'} onClick={() => run('reload')}>Reload</button><button className="btn ghost" disabled={busy || status.phase === 'resetting'} onClick={() => run('forget')}>Forget sign-in</button></div>
    </header>
    {(actionError || status.error) && <p className="whatsapp-batch-error" role="alert">{actionError || status.error}</p>}
    <div className="wa-desktop-surface" ref={surface} aria-label="Embedded WhatsApp website">
      <div className="wa-desktop-placeholder" role="status">
        <ProviderIcon provider="whatsapp" size={28} />
        <h3>{status.phase === 'error' ? 'WhatsApp could not load' : 'Opening inbox...'}</h3>
        {status.phase === 'error' && <p>Check your connection, then reload. Your sign-in stays saved.</p>}
      </div>
    </div>
    <p className="wa-desktop-note">Real messages. Sign-in stays on this computer account.</p>
  </section>;
}
