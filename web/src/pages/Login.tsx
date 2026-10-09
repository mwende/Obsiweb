import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { CompanyLogo } from '../components/CompanyLogo';

export function Login({ onLoggedIn }: { onLoggedIn: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(() => new URLSearchParams(location.search).get('error') ?? '');
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
      history.replaceState(null, '', '/');
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
        <CompanyLogo height={56} className="login-company" />
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
