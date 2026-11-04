# Obsiweb installieren

Diese Anleitung beschreibt die Installation auf einem eigenen Linux-Server (Beispiele für Debian/Ubuntu).
Für CloudPanel gibt es eine eigene Anleitung: [deploy/cloudpanel.md](deploy/cloudpanel.md).

## Voraussetzungen

- Linux-Server mit einer eigenen (Sub-)Domain, z.B. `notes.example.com`
- Node.js 22 oder neuer
- MySQL 8
- Nginx als Reverse-Proxy **auf demselben Server** und ein TLS-Zertifikat, z.B. von Let's Encrypt

HTTPS ist Pflicht: Über WebDAV werden Zugangsdaten per Basic Auth übertragen.

## 1. Pakete, Benutzer und Verzeichnisse

Node.js 22 installierst du am besten aus den Paketquellen von [NodeSource](https://github.com/nodesource/distributions).
Der Rest:

```bash
sudo apt install -y git nginx mysql-server certbot python3-certbot-nginx
sudo useradd --system --home /opt/obsiweb --shell /usr/sbin/nologin obsiweb
sudo mkdir -p /opt/obsiweb /var/lib/obsiweb
sudo chown obsiweb:obsiweb /opt/obsiweb /var/lib/obsiweb
sudo chmod 750 /var/lib/obsiweb
```

`/var/lib/obsiweb` nimmt später alle Notizen auf und liegt bewusst außerhalb des Programmverzeichnisses.

## 2. Datenbank anlegen

```bash
sudo mysql
```

```sql
CREATE DATABASE obsiweb CHARACTER SET utf8mb4;
CREATE USER 'obsiweb'@'127.0.0.1' IDENTIFIED BY 'SICHERES_PASSWORT';
GRANT ALL PRIVILEGES ON obsiweb.* TO 'obsiweb'@'127.0.0.1';
EXIT;
```

## 3. Code holen und bauen

```bash
sudo -u obsiweb -H git clone https://github.com/mwende/Obsiweb.git /opt/obsiweb
cd /opt/obsiweb
sudo -u obsiweb -H npm ci
sudo -u obsiweb -H npm run build
```

## 4. Konfiguration

```bash
sudo -u obsiweb cp .env.example .env
sudo chmod 600 .env
openssl rand -base64 48        # Ausgabe als SESSION_SECRET verwenden
sudo -u obsiweb nano .env
```

Mindestens diese Werte setzen:

```ini
BASE_URL=https://notes.example.com
PORT=3000
HOST=127.0.0.1
SESSION_SECRET=<Ausgabe von openssl>
DATABASE_URL=mysql://obsiweb:SICHERES_PASSWORT@127.0.0.1:3306/obsiweb
DATA_DIR=/var/lib/obsiweb
```

Sonderzeichen im Datenbank-Passwort müssen in `DATABASE_URL` URL-kodiert werden, z.B. `@` als `%40`.

`HOST` muss `127.0.0.1` bleiben. Die App vertraut nur einem Proxy auf demselben Rechner; läuft Nginx woanders,
erkennt sie die echten Client-IPs nicht und die Anmeldesperren treffen alle Nutzer gemeinsam.

## 5. Datenbank einrichten und ersten Admin anlegen

```bash
sudo -u obsiweb -H npm run migrate
sudo -u obsiweb -H npm run user:create -- --email du@example.com --name "Dein Name" --admin
```

Der zweite Befehl gibt ein **initiales Passwort** aus. Ändere es nach dem ersten Login unter *Einstellungen & Sync*.

## 6. Als Dienst starten

```bash
sudo cp deploy/obsiweb.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now obsiweb
systemctl status obsiweb
curl -i http://127.0.0.1:3000/auth/providers     # erwartet: HTTP 200
```

Logs: `journalctl -u obsiweb -f`.

## 7. Nginx und HTTPS

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/obsiweb
sudo nano /etc/nginx/sites-available/obsiweb     # server_name anpassen
sudo ln -s /etc/nginx/sites-available/obsiweb /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d notes.example.com
```

Prüfen:

```bash
curl -i -X OPTIONS https://notes.example.com/dav/     # erwartet: HTTP 200 und Header "dav: 1"
```

Danach ist die App unter `https://notes.example.com` erreichbar.

## 8. Eigenes Logo (optional)

Als Admin unter **Benutzerverwaltung → Logo** hochladen, je eine Variante für helle und dunkle Hintergründe.
Erlaubt sind PNG, JPEG, WebP und SVG bis 2 MB. Das Logo erscheint auf der Login-Seite und in der Kopfzeile; ohne Logo
wird dort nichts angezeigt.

Alternativ legst du die Dateien direkt ab: `$DATA_DIR/branding/logo-light.png` und `logo-dark.png`
(auch `.jpg`, `.webp`, `.svg`). Sie bleiben bei Updates erhalten.

## 9. Obsidian verbinden

1. In Obsiweb unter **Einstellungen & Sync** ein App-Passwort erzeugen.
2. In Obsidian das Community-Plugin **Remotely Save** installieren und als Dienst **WebDAV** wählen:
   - Adresse: `https://notes.example.com/dav/`
   - Benutzer: deine E-Mail
   - Passwort: das App-Passwort
   - Auth-Typ: `basic`
3. *Check* drücken, dann synchronisieren.

## Updates

```bash
cd /opt/obsiweb
sudo -u obsiweb -H git pull
sudo -u obsiweb -H npm ci
sudo -u obsiweb -H npm run build
sudo -u obsiweb -H npm run migrate
sudo systemctl restart obsiweb
```

## Backup

Zu sichern sind `DATA_DIR` (Notizen, Anhänge, Logo) und die Datenbank (Nutzer, App-Passwörter, Suchindex):

```bash
sudo tar czf obsiweb-daten-$(date +%F).tgz -C /var/lib obsiweb
sudo mysqldump obsiweb | gzip > obsiweb-db-$(date +%F).sql.gz
```

Den Suchindex baut die App beim Start aus den Dateien neu auf.

## Fehlersuche

| Problem | Ursache und Lösung |
|---|---|
| `Ungültige Konfiguration` beim Start | `.env` fehlt oder liegt nicht im Projektordner; Pflichtwerte siehe Schritt 4 |
| `502 Bad Gateway` | Dienst läuft nicht (`systemctl status obsiweb`) oder `PORT` passt nicht zu `proxy_pass` |
| Upload bricht mit `413` ab | `client_max_body_size` in Nginx und `MAX_UPLOAD_MB` in `.env` erhöhen |
| Remotely Save meldet einen Anmeldefehler | Es wird das App-Passwort gebraucht, nicht das Login-Passwort; Adresse muss auf `/dav/` enden |
| WebDAV antwortet mit `429` | Zu viele Fehlanmeldungen; die Sperre endet nach 15 Minuten |

## Optional: Login über Microsoft Entra ID

Siehe [deploy/cloudpanel.md](deploy/cloudpanel.md#7-optional-login-über-microsoft-entra-id). Die Schritte gelten
für jede Installation; statt `pm2 restart` genügt `sudo systemctl restart obsiweb`.
