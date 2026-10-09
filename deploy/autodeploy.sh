#!/usr/bin/env bash
# Automatisches Deployment für Obsiweb (per Cron als Site-User, z.B. jede Minute).
#
# Ablauf: neue Commits auf origin/$BRANCH? → fast-forward → npm ci → build → Tests → migrate
#         → pm2 restart → Health-Check. Schlägt ein Schritt fehl, wird auf den vorherigen
#         Commit zurückgerollt und dieser wieder gebaut und gestartet.
#
# Konfiguration über Umgebungsvariablen (alle optional):
#   APP_DIR     Projektverzeichnis              (Standard: Verzeichnis über diesem Skript)
#   BRANCH      zu deployender Branch           (Standard: main)
#   PM2_NAME    Name des pm2-Prozesses          (Standard: obsidianweb)
#   RUN_TESTS   1 = Tests vor dem Neustart      (Standard: 1, wird übersprungen, wenn SQLite fehlt)
#   LOG_FILE    Logdatei                        (Standard: $HOME/logs/obsiweb-deploy.log)
#   FORCE       1 = auch ohne neue Commits bauen und neu starten
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BRANCH="${BRANCH:-main}"
PM2_NAME="${PM2_NAME:-obsidianweb}"
RUN_TESTS="${RUN_TESTS:-1}"
LOG_FILE="${LOG_FILE:-$HOME/logs/obsiweb-deploy.log}"
FORCE="${FORCE:-0}"

mkdir -p "$(dirname "$LOG_FILE")"
log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG_FILE"; }

# Cron hat einen minimalen PATH → Node/npm/pm2 aus nvm bzw. npm-global laden
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
for bin in git node npm pm2 curl flock; do
  command -v "$bin" >/dev/null 2>&1 || { log "FEHLER: '$bin' nicht gefunden (PATH=$PATH)"; exit 1; }
done

# Nur ein Lauf gleichzeitig
exec 9>"/tmp/obsiweb-deploy-$(id -u).lock"
flock -n 9 || exit 0

cd "$APP_DIR" || { log "FEHLER: $APP_DIR nicht gefunden"; exit 1; }

if ! git fetch --quiet origin "$BRANCH" 2>>"$LOG_FILE"; then
  log "FEHLER: git fetch fehlgeschlagen (Token/Netzwerk?)"
  exit 1
fi

OLD="$(git rev-parse HEAD)"
NEW="$(git rev-parse "origin/$BRANCH")"
if [ "$OLD" = "$NEW" ] && [ "$FORCE" != "1" ]; then
  exit 0 # nichts zu tun
fi
if [ "$FORCE" != "1" ] && [ -f .deploy-failed ] && [ "$(cat .deploy-failed)" = "$NEW" ]; then
  exit 0 # dieser Commit ist bereits fehlgeschlagen → auf neuen Push warten
fi

PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]\"')"
PORT="${PORT:-3000}"

run() { # Befehl ausführen, Ausgabe ins Log
  log "> $*"
  "$@" >>"$LOG_FILE" 2>&1
}

build() {
  run npm ci --no-audit --no-fund || return 1
  run npm run build || return 1
  if [ "$RUN_TESTS" = "1" ]; then
    if node -e "require('better-sqlite3')" >/dev/null 2>&1; then
      run npm test || return 1
    else
      log "Tests übersprungen (better-sqlite3 nicht verfügbar)"
    fi
  fi
  run npm run migrate || return 1
}

restart_and_check() {
  run pm2 restart "$PM2_NAME" --update-env || return 1
  for _ in $(seq 1 20); do
    sleep 1
    if curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$PORT/auth/providers"; then
      return 0
    fi
  done
  log "Health-Check auf Port $PORT fehlgeschlagen"
  return 1
}

log "Deployment ${OLD:0:7} → ${NEW:0:7} gestartet"
if ! git merge --ff-only --quiet "origin/$BRANCH" >>"$LOG_FILE" 2>&1; then
  log "FEHLER: kein Fast-Forward möglich (lokale Änderungen auf dem Server?). Abbruch, nichts geändert."
  exit 1
fi

if build && restart_and_check; then
  pm2 save >/dev/null 2>&1
  rm -f .deploy-failed
  log "Deployment ${NEW:0:7} erfolgreich: $(git log -1 --format=%s)"
  exit 0
fi

log "FEHLER beim Deployment von ${NEW:0:7} → Rollback auf ${OLD:0:7}"
git reset --hard --quiet "$OLD"
if build && restart_and_check; then
  log "Rollback auf ${OLD:0:7} erfolgreich. Der fehlerhafte Commit wird erst nach einem neuen Push erneut versucht."
  # Merken, damit der kaputte Commit nicht jede Minute neu gebaut wird
  echo "$NEW" >"$APP_DIR/.deploy-failed"
else
  log "KRITISCH: Rollback fehlgeschlagen – bitte manuell prüfen (pm2 logs $PM2_NAME)"
fi
exit 1
