import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Me } from '../api';
import { useDialog } from '../components/Dialog';
import { TopBar } from '../components/TopBar';

type AppPw = { id: number; label: string; lastUsedAt: number | null; createdAt: string };

export function Settings({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const dialog = useDialog();
  const [items, setItems] = useState<AppPw[]>([]);
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState<{ label: string; token: string } | null>(null);
  const [pw, setPw] = useState({ current: '', next: '', repeat: '' });
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = async () => setItems((await api.appPasswords()).items);
  useEffect(() => {
    void reload();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    const r = await api.createAppPassword(label.trim());
    setFresh({ label: r.label, token: r.token });
    setLabel('');
    await reload();
  };

  const changePw = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.next !== pw.repeat) return setPwMsg({ ok: false, text: 'Die neuen Passwörter stimmen nicht überein.' });
    try {
      await api.changePassword(pw.current, pw.next);
      setPw({ current: '', next: '', repeat: '' });
      setPwMsg({ ok: true, text: 'Passwort geändert.' });
    } catch (err) {
      setPwMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Fehler' });
    }
  };

  return (
    <div className="app page">
      <TopBar me={me} onLogout={onLogout} />
      <main className="page-body">
        <h1>Einstellungen &amp; Sync</h1>

        <section className="card">
          <h2>Obsidian verbinden (Remotely Save)</h2>
          <ol className="steps">
            <li>
              In Obsidian unter <em>Einstellungen → Community-Plugins</em> das Plugin <strong>Remotely Save</strong> installieren und
              aktivieren.
            </li>
            <li>
              Als <em>Remote Service</em> <strong>WebDAV</strong> wählen und eintragen:
              <dl className="kv">
                <dt>Server-Adresse</dt>
                <dd>
                  <CopyField value={me.davUrl} />
                </dd>
                <dt>Benutzername</dt>
                <dd>
                  <CopyField value={me.user.email} />
                </dd>
                <dt>Passwort</dt>
                <dd>ein App-Passwort von unten (nicht dein Login-Passwort)</dd>
                <dt>Auth-Typ</dt>
                <dd>basic</dd>
                <dt>Depth-Header</dt>
                <dd>„supports depth=infinity“ (schneller) oder „only supports depth=1“</dd>
              </dl>
            </li>
            <li>
              <em>Check</em> drücken, dann synchronisieren. Remotely Save legt den Vault in einem Ordner mit dem Vault-Namen ab – er
              erscheint hier als oberster Ordner. Mehrere Vaults landen in mehreren Ordnern.
            </li>
            <li>Auf jedem Gerät (Desktop, iPhone, Android) dieselben Daten verwenden, idealerweise mit eigenem App-Passwort je Gerät.</li>
          </ol>
        </section>

        <section className="card">
          <h2>App-Passwörter</h2>
          <p className="muted">Für WebDAV-Clients wie Remotely Save. Jedes Passwort kann einzeln widerrufen werden.</p>
          {fresh && (
            <div className="notice">
              <p>
                Neues App-Passwort für <strong>{fresh.label}</strong> – es wird nur jetzt angezeigt:
              </p>
              <CopyField value={fresh.token} />
              <button className="ghost small" onClick={() => setFresh(null)}>
                Ausblenden
              </button>
            </div>
          )}
          <form className="row" onSubmit={create}>
            <input placeholder="Bezeichnung, z.B. „MacBook“ oder „iPhone“" value={label} onChange={(e) => setLabel(e.target.value)} />
            <button className="primary">Erzeugen</button>
          </form>
          <table className="table">
            <thead>
              <tr>
                <th>Bezeichnung</th>
                <th>Zuletzt benutzt</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted">
                    Noch keine App-Passwörter.
                  </td>
                </tr>
              )}
              {items.map((i) => (
                <tr key={i.id}>
                  <td>{i.label}</td>
                  <td className="muted">{i.lastUsedAt ? new Date(i.lastUsedAt).toLocaleString('de-DE') : 'nie'}</td>
                  <td className="right">
                    <button
                      className="ghost danger-text"
                      onClick={async () => {
                        if (await dialog.confirm('App-Passwort widerrufen?', `Geräte mit „${i.label}“ können danach nicht mehr synchronisieren.`, 'Widerrufen')) {
                          await api.deleteAppPassword(i.id);
                          await reload();
                        }
                      }}
                    >
                      Widerrufen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Login-Passwort</h2>
          {me.user.entraLinked && <p className="muted">Dein Konto ist mit Microsoft verknüpft. Ein lokales Passwort ist optional.</p>}
          <form className="stack narrow" onSubmit={changePw}>
            {me.user.hasPassword && (
              <input type="password" placeholder="Aktuelles Passwort" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
            )}
            <input type="password" placeholder="Neues Passwort (mind. 10 Zeichen)" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            <input type="password" placeholder="Neues Passwort wiederholen" autoComplete="new-password" value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} />
            {pwMsg && <div className={pwMsg.ok ? 'success' : 'error'}>{pwMsg.text}</div>}
            <button className="primary">Passwort ändern</button>
          </form>
        </section>
      </main>
      {dialog.element}
    </div>
  );
}

export function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copy-field">
      <code>{value}</code>
      <button
        type="button"
        className="ghost small"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Kopiert ✓' : 'Kopieren'}
      </button>
    </span>
  );
}
