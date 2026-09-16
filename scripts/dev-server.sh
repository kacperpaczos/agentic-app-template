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
    cd "$ROOT"
    APP_DATA_DIR="$ROOT/data" APP_WEB_DIST="$ROOT/apps/web/dist" \
      setsid node apps/server/dist/server.js > "$LOG" 2>&1 < /dev/null &
    echo $! > "$PIDFILE"
    for _ in $(seq 1 40); do
      if curl -fsS http://127.0.0.1:8791/api/health > /dev/null 2>&1; then
        echo "started pid=$(cat "$PIDFILE")"; exit 0
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
