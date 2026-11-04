import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type LogoVariant, type Me, type User } from '../api';
import { setBranding, useBranding } from '../components/BrandLogo';
import { useDialog } from '../components/Dialog';
import { TopBar } from '../components/TopBar';

export function Admin({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const dialog = useDialog();
  const branding = useBranding();
  const [users, setUsers] = useState<User[]>([]);
  const [form, setForm] = useState({ email: '', displayName: '', password: '', isAdmin: false });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = async () => setUsers((await api.users()).users);
  useEffect(() => {
    void reload();
  }, []);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      await reload();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Fehler' });
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.createUser({ ...form, password: form.password || undefined });
      setForm({ email: '', displayName: '', password: '', isAdmin: false });
    }, `Nutzer ${form.email} angelegt.`);
  };

  return (
    <div className="app page">
      <TopBar me={me} onLogout={onLogout} />
      <main className="page-body">
        <h1>Benutzerverwaltung</h1>
        {msg && <div className={msg.ok ? 'success' : 'error'}>{msg.text}</div>}

        <section className="card">
          <h2>Logo</h2>
          <p className="muted">
            Erscheint auf der Login-Seite und in der Kopfzeile. PNG, JPEG, WebP oder SVG, höchstens 2 MB. Ist nur eine Variante
            hinterlegt, wird sie für beide Farbschemata verwendet.
          </p>
          <div className="logo-grid">
            {(['light', 'dark'] as LogoVariant[]).map((variant) => (
              <div key={variant} className={`logo-slot logo-slot-${variant}`}>
                <strong>{variant === 'light' ? 'Für helle Hintergründe' : 'Für dunkle Hintergründe'}</strong>
                <div className="logo-preview">
                  {branding?.[variant] ? <img src={branding[variant]!} alt="" /> : <span>Kein Logo</span>}
                </div>
                <div className="row">
                  <label className="button">
                    Hochladen
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/svg+xml"
                      hidden
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) void run(async () => setBranding(await api.uploadLogo(variant, file)), 'Logo gespeichert.');
                      }}
                    />
                  </label>
                  <button className="ghost danger-text" onClick={() => void run(async () => setBranding(await api.removeLogo(variant)), 'Logo entfernt.')}>
                    Entfernen
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <h2>Neuer Nutzer</h2>
          <form className="grid-form" onSubmit={create}>
            <input type="email" placeholder="E-Mail" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <input placeholder="Anzeigename" required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
            <input type="password" placeholder="Passwort (leer = nur Microsoft-Login)" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            <label className="check">
              <input type="checkbox" checked={form.isAdmin} onChange={(e) => setForm({ ...form, isAdmin: e.target.checked })} /> Administrator
            </label>
            <button className="primary">Anlegen</button>
          </form>
        </section>

        <section className="card">
          <div className="row between">
            <h2>Nutzer</h2>
            <button className="ghost" onClick={() => void run(() => api.reindex(), 'Suchindex neu aufgebaut.')}>
              Suchindex neu aufbauen
            </button>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>E-Mail</th>
                <th>Anmeldung</th>
                <th>Rolle</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.displayName}</td>
                  <td>{u.email}</td>
                  <td className="muted">{[u.hasPassword && 'Passwort', u.entraLinked && 'Microsoft'].filter(Boolean).join(', ') || '–'}</td>
                  <td>{u.isAdmin ? 'Admin' : 'Nutzer'}</td>
                  <td className="right nowrap">
                    <button
                      className="ghost"
                      onClick={async () => {
                        const pw = await dialog.prompt(`Neues Passwort für ${u.email}`, '', 'Setzen');
                        if (pw) void run(() => api.updateUser(u.id, { password: pw }), 'Passwort gesetzt.');
                      }}
                    >
                      Passwort
                    </button>
                    {u.id !== me.user.id && (
                      <>
                        <button className="ghost" onClick={() => void run(() => api.updateUser(u.id, { isAdmin: !u.isAdmin }), 'Rolle geändert.')}>
                          {u.isAdmin ? 'Admin entziehen' : 'Zum Admin'}
                        </button>
                        <button
                          className="ghost danger-text"
                          onClick={async () => {
                            const choice = await dialog.choose(`${u.email} löschen?`, 'Das Konto wird entfernt. Sollen auch alle Notizen dieses Nutzers gelöscht werden?', [
                              { label: 'Nur Konto', value: 'keep' },
                              { label: 'Konto + Notizen', value: 'all' },
                            ]);
                            if (choice) void run(() => api.deleteUser(u.id, choice === 'all'), 'Nutzer gelöscht.');
                          }}
                        >
                          Löschen
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
      {dialog.element}
    </div>
  );
}
