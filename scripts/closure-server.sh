#!/usr/bin/env bash
# DIAGNOSTIC (closure 2026-09-15) — isolated backend instance for verification.
# Own data directory and port, so the user's data/ and running instance are never touched.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${CLOSURE_DATA:-$(cat /tmp/closure_data_dir)}"
PORT="${CLOSURE_PORT:-8796}"
PIDFILE="/tmp/closure-server-$PORT.pid"
LOG="/tmp/closure-server-$PORT.log"

case "${1:-start}" in
  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo "running $(cat "$PIDFILE")"; exit 0; fi
    cd "$ROOT"
    APP_DATA_DIR="$DATA" APP_WEB_DIST="$ROOT/apps/web/dist" PORT="$PORT" \
      APP_ALLOWED_ORIGINS="http://127.0.0.1:$PORT,http://localhost:$PORT" \
      setsid node apps/server/dist/server.js > "$LOG" 2>&1 < /dev/null &
    echo $! > "$PIDFILE"
    for _ in $(seq 1 60); do
      curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && { echo "started pid=$(cat "$PIDFILE") port=$PORT data=$DATA"; exit 0; }
      sleep 0.25
    done
    echo "FAILED"; tail -20 "$LOG"; exit 1 ;;
  stop)
    [ -f "$PIDFILE" ] && { kill "$(cat "$PIDFILE")" 2>/dev/null; rm -f "$PIDFILE"; }
    echo stopped ;;
  restart) "$0" stop >/dev/null; sleep 0.5; "$0" start ;;
  pid) cat "$PIDFILE" 2>/dev/null ;;
  log) tail -n "${2:-40}" "$LOG" ;;
  *) echo "usage: $0 start|stop|restart|pid|log"; exit 2 ;;
esac
