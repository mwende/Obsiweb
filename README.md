# Obsiweb

Selbst gehostete Web-App für Markdown-Notizen, die mit **Obsidian** synchron bleibt.

- **Sync:** Die App ist selbst ein WebDAV-Server. Obsidian (Desktop, iOS, Android) synchronisiert über das
  Community-Plugin [Remotely Save](https://github.com/remotely-save/remotely-save).
- **Speicher:** Notizen liegen als echte `.md`-Dateien im Dateisystem (ein Ordner pro Nutzer). MySQL hält
  Nutzer, App-Passwörter und den Volltextindex.
- **Web-Oberfläche:** Ordnerbaum, Markdown-Editor mit Live-Vorschau, `[[Wikilinks]]`, `![[Bilder]]`,
  Volltextsuche, Upload per Drag & Drop oder Einfügen, Konflikterkennung, mobil nutzbar.
- **Vorlagen:** `Cmd/Strg+Alt+T` fügt eine Vorlage aus dem Vault ein (z.B. PowerShell-Schnipsel), kompatibel
  zu Obsidians Core-Plugin *Vorlagen* inkl. `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}`.
- **Nutzer:** mehrere Konten, Admin-Verwaltung, App-Passwörter pro Gerät, optional Login über Microsoft Entra ID.

```
Obsidian ── Remotely Save (WebDAV, App-Passwort) ──┐
                                                   ▼
Browser ── HTTPS (Session) ──►  Fastify (Node 22)  /auth  /api  /dav
                                     │
                       VaultService (einzige Schreibstelle)
                         ├─ Dateien:  $DATA_DIR/vaults/<userId>/…
                         └─ MySQL:    users, sessions, app_passwords, files (+FULLTEXT)
```

## Installation

Siehe [INSTALL.md](INSTALL.md) für einen eigenen Linux-Server und [deploy/cloudpanel.md](deploy/cloudpanel.md) für CloudPanel.

## Lokale Entwicklung

Voraussetzung: Node.js ≥ 22. Lokal kann statt MySQL **SQLite** verwendet werden.

```bash
npm install
cp .env.example .env
# in .env: DATABASE_URL=sqlite:./data/dev.sqlite, DATA_DIR=./data,
#          BASE_URL=http://localhost:3000, SESSION_SECRET=<32+ Zeichen>
npm run build
npm run user:create -- --email ich@example.com --name "Ich" --admin
npm run dev:server     # API + WebDAV auf :3000 (liefert auch das gebaute Frontend aus)
npm run dev:web        # optional: Vite-Dev-Server mit Hot Reload auf :5173
npm test               # Server-Tests (Vault, WebDAV, API)
```

## Obsidian verbinden

1. In der Web-App unter **Einstellungen & Sync** ein App-Passwort erzeugen.
2. In Obsidian **Remotely Save** installieren und *WebDAV* wählen:
   - Adresse: `https://<deine-domain>/dav/`
   - Benutzer: deine E-Mail
   - Passwort: das App-Passwort
   - Auth-Typ: `basic`
3. *Check* → *Sync*.

Remotely Save legt den Vault in einem Ordner mit dem Vault-Namen ab. Er erscheint in der Web-App als oberster
Ordner. Mit der Web-App bearbeitete Notizen übernimmt Obsidian beim nächsten Sync. Ändert jemand eine Notiz,
während sie im Browser offen ist, erkennt die Web-App das am ETag und fragt nach, statt zu überschreiben.

## Vorlagen

Vorlagen sind normale Notizen in einem Ordner des Vaults. Die Web-App sucht den Ordner in dieser Reihenfolge:

1. manuell gesetzt unter *Einstellungen & Sync → Vorlagen* (pro Browser)
2. aus Obsidians Einstellung `.obsidian/templates.json` (nur wenn Remotely Save den Konfigurationsordner mitsynchronisiert)
3. ein Ordner namens `Vorlagen` oder `Templates` (bevorzugt im Vault der aktuellen Notiz)

In Obsidian denselben Ordner unter *Einstellungen → Vorlagen* eintragen und unter *Tastenkürzel* „Vorlagen: Vorlage
einfügen“ belegen, dann funktionieren dieselben Schnipsel auf beiden Seiten.

## Logo

Das Logo ist nicht Teil des Codes. Admins laden es unter **Benutzerverwaltung → Logo** hoch, je eine Variante für
helle und dunkle Hintergründe (PNG, JPEG, WebP, SVG, bis 2 MB). Es liegt in `$DATA_DIR/branding/` und bleibt bei
Updates erhalten. Ohne Logo zeigt die App nur ihren Namen.

## Sicherheit

- Passwörter: scrypt (Node `crypto`); App-Passwörter und Session-Tokens werden nur als SHA-256 gespeichert.
- Sessions: `HttpOnly`/`SameSite=Lax`/`Secure`-Cookie, CSRF-Token für alle schreibenden API-Aufrufe. Ein
  Passwortwechsel beendet alle anderen Sitzungen.
- Brute-Force-Schutz: Login 10 Versuche/Minute pro IP, WebDAV-Sperre nach 30 Fehlversuchen/15 Minuten pro IP.
  Die Client-IP stammt nur vom lokalen Proxy (`trustProxy` = Loopback), gefälschte `X-Forwarded-For` wirken nicht.
- Header: CSP (`script-src 'self'`, `frame-ancestors 'none'`), HSTS, `nosniff`, `X-Frame-Options`.
  Vault-Dateien (`/dav`, `/api/raw`) werden mit `CSP: sandbox` ausgeliefert, HTML/SVG über WebDAV als Download.
- Pfade werden strikt normalisiert (`..`, `\`, NUL, kodierte `/` abgelehnt); jeder Nutzer ist auf seinen Vault beschränkt.
- Vault-Verzeichnisse sind nur für den App-Benutzer lesbar (`700`, `umask 077`).
- **Entra ID:** Microsoft-Identitäten werden beim ersten Login über die E-Mail-Adresse mit lokalen Konten
  verknüpft. Das ist nur sicher, solange `ALLOWED_TENANTS` ausschließlich den eigenen Mandanten enthält, dessen
  Adressen ihr selbst verwaltet. Keine fremden oder Multi-Tenant-Mandanten freischalten.
- Nicht enthalten: Speicherkontingente pro Nutzer, Zwei-Faktor-Anmeldung für lokale Konten.

## Bekannte Einschränkungen

- Beim Umbenennen in der Web-App werden Links in anderen Notizen nicht automatisch angepasst (anders als in
  Obsidian selbst).
- WebDAV-Locks (`LOCK`/`UNLOCK`) werden nicht unterstützt. Für Remotely Save sind sie nicht nötig; macOS Finder
  bindet den Server deshalb nur lesend ein.
- Dead Properties (`PROPPATCH`) werden nicht gespeichert.
