import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { BrandLogo } from '../components/BrandLogo';

/** Nur feste Texte anzeigen, damit ein präparierter Link keine eigene Meldung einschleusen kann */
const LOGIN_ERRORS: Record<string, string> = {
  expired: 'Anmeldevorgang abgelaufen, bitte erneut versuchen.',
  failed: 'Anmeldung bei Microsoft fehlgeschlagen.',
  'no-identity': 'Microsoft hat keine gültigen Identitätsdaten geliefert.',
  tenant: 'Dieser Mandant ist nicht zugelassen.',
  linked: 'Das Konto ist bereits mit einer anderen Microsoft-Identität verknüpft.',
  'no-account': 'Für diese Microsoft-Identität gibt es kein Konto.',
};
const loginError = (code: string | null) => (code ? (LOGIN_ERRORS[code] ?? 'Anmeldung fehlgeschlagen.') : '');

export function Login({ onLoggedIn }: { onLoggedIn: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(() => loginError(new URLSearchParams(location.search).get('error')));
  const [busy, setBusy] = useState(false);
  const [entra, setEntra] = useState(false);

  useEffect(() => {
    api.providers().then((p) => setEntra(p.entra), () => {});
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(email, password);
      // Nach dem Login auf der ursprünglich aufgerufenen Seite bleiben (z.B. ?note=…)
      if (location.pathname === '/login' || location.search.includes('error=')) history.replaceState(null, '', '/');
      await onLoggedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Anmeldung fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit}>
        <BrandLogo height={56} className="login-company" />
        <div className="brand">
          <Logo /> Obsiweb
        </div>
        <label>
          E-Mail
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Passwort
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>
          {busy ? 'Anmelden …' : 'Anmelden'}
        </button>
        {entra && (
          <>
            <div className="divider">oder</div>
            <a className="button" href="/auth/entra/login">
              Mit Microsoft anmelden
            </a>
          </>
        )}
      </form>
    </div>
  );
}

export function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
      <path d="M16 2 4 9v14l12 7 12-7V9z" fill="var(--accent)" />
      <path d="M16 2v28M4 9l12 7 12-7" stroke="var(--bg)" strokeWidth="1.5" fill="none" opacity=".5" />
    </svg>
  );
}
