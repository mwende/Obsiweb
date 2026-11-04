import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Me } from '../api';
import { Logo } from '../pages/Login';
import { BrandLogo } from './BrandLogo';
import { navigate } from '../router';

export function TopBar({ me, onLogout, children, left }: { me: Me; onLogout: () => void; children?: ReactNode; left?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  return (
    <header className="topbar">
      {left}
      <a className="brand" href="/" onClick={(e) => (e.preventDefault(), navigate('/'))}>
        <Logo /> <span className="hide-sm">Obsiweb</span>
      </a>
      <div className="topbar-center">{children}</div>
      <BrandLogo height={22} className="topbar-company hide-sm" />
      <div className="menu" ref={ref}>
        <button className="ghost avatar" onClick={() => setOpen((o) => !o)} title={me.user.email} aria-haspopup="menu">
          {initials(me.user.displayName)}
        </button>
        {open && (
          <div className="menu-pop" role="menu" onClick={() => setOpen(false)}>
            <div className="menu-head">
              <strong>{me.user.displayName}</strong>
              <span className="muted">{me.user.email}</span>
            </div>
            <button onClick={() => navigate('/')}>Notizen</button>
            <button onClick={() => navigate('/settings')}>Einstellungen &amp; Sync</button>
            {me.user.isAdmin && <button onClick={() => navigate('/admin')}>Benutzerverwaltung</button>}
            <button onClick={onLogout}>Abmelden</button>
          </div>
        )}
      </div>
    </header>
  );
}

const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join('');
