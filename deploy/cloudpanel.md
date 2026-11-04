# Deployment auf CloudPanel

Erprobt auf CloudPanel v2 mit Node.js 22 und MySQL 8. Platzhalter: `notes.example.com` (Domain),
`obsidianweb` (Site-User).

## 1. Site und Datenbank anlegen

1. **Sites → Add Site → Create a Node.js Site**
   - Domain: `notes.example.com`
   - Node.js-Version: **22**
   - App Port: `3000`
   - Site User: `obsidianweb`
2. **SSL/TLS** → Let's-Encrypt-Zertifikat ausstellen.
3. **Databases → Add Database**: Name `obsidianweb`, User `obsidianweb`, sicheres Passwort.

## 2. Code installieren

Bei einem privaten Repo zuerst einen Lese-Token erzeugen, den Git statt eines Passworts verwendet.
Dann per SSH als Site-User anmelden (`ssh obsidianweb@server`):

```bash
git config --global credential.helper store   # Token für spätere `git pull` merken (~/.git-credentials)
cd ~/htdocs/notes.example.com
git clone <REPO-URL> .   # bei privatem Repo: Passwort = Token
cp .env.example .env
nano .env        # siehe unten
npm ci
npm run build
npm run migrate
npm run user:create -- --email du@example.com --name "Dein Name" --admin
```

Das letzte Kommando gibt ein **initiales Passwort** aus. Nach dem ersten Login unter *Einstellungen* ändern.

### `.env`

```ini
BASE_URL=https://notes.example.com
PORT=3000
HOST=127.0.0.1
SESSION_SECRET=<openssl rand -base64 48>
DATABASE_URL=mysql://obsidianweb:<DB-PASSWORT>@127.0.0.1:3306/obsidianweb
DATA_DIR=/home/obsidianweb/obsidianweb-data
MAX_UPLOAD_MB=100
```

`DATA_DIR` liegt bewusst **außerhalb** von `htdocs`. Enthält das DB-Passwort Sonderzeichen wie `@ : / #`,
müssen sie in der URL kodiert werden (z.B. `@` → `%40`).

## 3. Dauerhaft starten (PM2)

```bash
npm install -g pm2          # falls nicht vorhanden; ggf. ~/.npm-global verwenden
pm2 start npm --name obsidianweb -- start
pm2 save
crontab -e                  # Zeile ergänzen, damit die App nach einem Reboot startet:
# @reboot cd /home/obsidianweb/htdocs/notes.example.com && /usr/bin/env pm2 resurrect
```

Logs: `pm2 logs obsidianweb`.

## 4. Nginx-Vhost anpassen

In CloudPanel unter **Sites → notes.example.com → Vhost** den Inhalt durch
[`nginx-vhost.snippet`](nginx-vhost.snippet) ersetzen (`server_name` anpassen) und speichern.
Entscheidend ist der zusätzliche Block `location ^~ /dav`: Er reicht WebDAV-URLs unverändert an die App
durch (`proxy_pass` ohne abschließenden `/`) und streamt Uploads.

Prüfen:

```bash
curl -i -X OPTIONS https://notes.example.com/dav/      # → 200, Header "DAV: 1"
```

## 5. Updates – automatisch per Gitea Action

Bei jedem Push auf `main` startet `.gitea/workflows/deploy.yml`. Der Runner verbindet
sich per SSH mit dem Server und ruft `deploy/autodeploy.sh` auf:

1. `git merge --ff-only` auf den neuen Stand
2. `npm ci` → `npm run build` → `npm test` → `npm run migrate`
3. `pm2 restart` und Health-Check auf `http://127.0.0.1:$PORT/auth/providers`
4. **Schlägt ein Schritt fehl**, wird automatisch auf den vorherigen Commit zurückgerollt und dieser wieder
   gestartet. Der Action-Lauf wird dann rot; der fehlerhafte Commit wird erst nach einem neuen Push
   (oder manuellem Start) erneut versucht.

Das Deploy-Log erscheint im Gitea-Tab **Actions** und zusätzlich in `~/logs/obsiweb-deploy.log` auf dem Server.
*Actions → Deploy to Production → Run workflow* erzwingt ein Neu-Deployment, auch ohne neue Commits.

### Einrichtung

1. **SSH-Schlüssel für den Runner** (auf dem Server als Site-User):
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/gitea_deploy -N "" -C "gitea-actions-obsiweb"
   cat ~/.ssh/gitea_deploy.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
   cat ~/.ssh/gitea_deploy        # privaten Schlüssel für SSH_KEY kopieren
   ```
2. **Secrets im Gitea-Repo** (*Einstellungen → Actions → Secrets*):
   `SSH_HOST` (Server), `SSH_PORT` (meist `22`), `SSH_USER` (Site-User), `SSH_KEY` (privater Schlüssel komplett,
   inkl. `-----BEGIN …-----`/`-----END …-----`).
3. Der Pfad zum Projekt steht in `.gitea/workflows/deploy.yml` (`APP_DIR`).
4. Git auf dem Server muss ohne Rückfrage vom Repo holen können (Token per `credential.helper store`, Schritt 2).

### Alternative ohne Runner: Cron

```cron
* * * * * /home/obsidianweb/htdocs/notes.example.com/deploy/autodeploy.sh
```

Nicht beides gleichzeitig verwenden (ein Lock verhindert Doppelläufe, die Action meldet dann aber „übersprungen“).

Manuell geht es weiterhin so:

```bash
cd ~/htdocs/notes.example.com
git pull
npm ci
npm run build
npm run migrate
pm2 restart obsidianweb
```

## 6. Backup

Zu sichern sind **das Datenverzeichnis** (die eigentlichen `.md`-Dateien) und die **Datenbank**
(Nutzer, App-Passwörter, Suchindex). Der Suchindex lässt sich jederzeit neu aufbauen: Beim Start gleicht
die App ihn mit dem Dateisystem ab, außerdem gibt es den Button in der Benutzerverwaltung.

Beispiel-Cronjob (täglich 3 Uhr):

```cron
0 3 * * * tar czf ~/backups/vaults-$(date +\%F).tgz -C ~ obsidianweb-data && find ~/backups -name 'vaults-*' -mtime +14 -delete
```

Für die Datenbank können die CloudPanel-Backups genutzt werden (oder `mysqldump`).

## 7. Optional: Login über Microsoft Entra ID

1. Im [Azure-Portal](https://portal.azure.com) → **Microsoft Entra ID → App-Registrierungen → Neue Registrierung**
   - Kontotypen: *Nur Konten in diesem Organisationsverzeichnis*
   - Umleitungs-URI (Web): `https://notes.example.com/auth/callback`
2. **Zertifikate & Geheimnisse** → neuen geheimen Clientschlüssel erstellen.
3. In `.env` ergänzen:
   ```ini
   ENTRA_TENANT_ID=<Verzeichnis-ID (Mandant)>
   ENTRA_CLIENT_ID=<Anwendungs-ID (Client)>
   ENTRA_CLIENT_SECRET=<Wert des geheimen Schlüssels>
   # ENTRA_AUTO_CREATE=true   # unbekannte Nutzer des Mandanten automatisch anlegen
   ```
4. `pm2 restart obsidianweb`. Auf der Login-Seite erscheint jetzt „Mit Microsoft anmelden“.

Beim ersten Microsoft-Login wird das Konto über die E-Mail-Adresse mit einem bestehenden lokalen Konto verknüpft.
Ohne `ENTRA_AUTO_CREATE=true` muss ein Admin das Konto vorher anlegen; das Passwortfeld kann dabei leer bleiben.
Für den Obsidian-Sync brauchen auch Microsoft-Nutzer ein **App-Passwort** (Einstellungen → App-Passwörter).
