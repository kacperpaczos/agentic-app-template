#!/usr/bin/env bash
# Starts/stops the production backend for manual and scripted verification.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE=/tmp/agentic-server.pid
LOG=/tmp/agentic-server.log

case "${1:-start}" in
  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "already running pid=$(cat "$PIDFILE")"; exit 0
    fi
    # Katalog danych i portu instancji weryfikacyjnej: domyślnie jak dotąd,
    # nadpisywalne.
    DATA="${DEV_DATA:-$ROOT/data}"
    PORT="${DEV_PORT:-8791}"
    cd "$ROOT"
    # ETAP 2, dziura 1 — odmowa, gdy katalog danych wygląda na żywe dane
    # aplikacji. Ta instancja startuje bez etykiety, a straż w config.ts
    # ogranicza wyłącznie instancje testowe, więc kontrolę sprawuje warstwa
    # skryptowa — zanim cokolwiek zostanie uruchomione.
    # ETAP 2, dziura 3 — sonda portu PRZED startem: skrypt, który zaczyna
    # startować na zajęty porcie, nie „startuje", tylko podpina się pod cudzą
    # instancję.
    node scripts/lib/server-guard.mjs przed --katalog "$DATA" --port "$PORT" --repo "$ROOT" || exit $?
    APP_DATA_DIR="$DATA" APP_WEB_DIST="$ROOT/apps/web/dist" PORT="$PORT" \
      setsid node apps/server/dist/server.js > "$LOG" 2>&1 < /dev/null &
    echo $! > "$PIDFILE"
    for _ in $(seq 1 40); do
      if curl -fsS "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1; then
        # ETAP 2, dziura 3 — „started" dopiero, gdy potwierdzono, że port
        # trzyma własny proces z pidfile, a nie cudza instancja.
        node scripts/lib/server-guard.mjs po --pid "$(cat "$PIDFILE")" --port "$PORT" || {
          echo "nie potwierdzono wlasnego procesu na porcie $PORT; log:"; tail -n 20 "$LOG"; exit 1;
        }
        echo "started pid=$(cat "$PIDFILE") port=$PORT data=$DATA"; exit 0
      fi
      sleep 0.25
    done
    echo "failed to start; log:"; cat "$LOG"; exit 1
    ;;
  stop)
    # Only the process this script started, identified by the pid file it wrote.
    #
    # This used to end with `pkill -f 'apps/server/dist/server.js'`, which matches
    # *every* backend on the machine — including one the user started by hand.
    # It did exactly that once. A cleanup may only ever remove what it created.
    if [ -f "$PIDFILE" ]; then
      PID="$(cat "$PIDFILE")"
      if kill -0 "$PID" 2>/dev/null; then kill "$PID" 2>/dev/null || true; fi
      rm -f "$PIDFILE"
      echo "stopped pid=$PID"
    else
      echo "nothing to stop: brak $PIDFILE (ten skrypt nie uruchamial zadnego serwera)"
    fi
    ;;
  log) tail -n 60 "$LOG" ;;
  *) echo "usage: $0 start|stop|log"; exit 2 ;;
esac
