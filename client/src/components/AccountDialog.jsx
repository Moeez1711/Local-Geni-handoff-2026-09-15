import { useEffect, useId, useRef } from 'react';
import { IconButton } from './ui.jsx';

export function AccountAvatar({ user, className = '' }) {
  return <span className={`account-avatar ${className}`}>{user?.avatar ? <img src={user.avatar} alt=""/> : (user?.name || 'L').trim().slice(0, 1).toUpperCase()}</span>;
}

export default function AccountDialog({ title, children, onClose, busy = false, className = '' }) {
  const dialog = useRef(null), titleId = useId();
  useEffect(() => { const node = dialog.current; node.showModal(); return () => node.close(); }, []);
  return <dialog ref={dialog} className={`account-dialog ${className}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id={titleId}>{title}</h2><IconButton icon="close" label={`Close ${title.toLowerCase()}`} disabled={busy} onClick={onClose}/></header>
    {children}
  </dialog>;
}
