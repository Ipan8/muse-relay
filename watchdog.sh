#!/usr/bin/env bash
# watchdog.sh — Cek bot relay tiap 5 menit, restart kalau mati.
#
# Cara pakai (cron, tiap 5 menit):
#   */5 * * * * /home/<user>/muse-relay/watchdog.sh >> /home/<user>/muse-relay/data/watchdog.log 2>&1
#
# Atau systemd timer (lihat muse-relay.service untuk versi service).
# Skrip ini satu-shot: cek sekali lalu keluar. JANGAN dijalankan sebagai loop.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/data/relay.pid"
LOG_FILE="$DIR/data/watchdog.log"
mkdir -p "$DIR/data"

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

alive=0
if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    # pastikan PID itu memang relay.js, bukan proses lain yang kebetulan pakai PID sama
    if ps -p "$PID" -o args= 2>/dev/null | grep -q "relay.js"; then
      alive=1
    fi
  fi
fi
# Fallback: kalau tidak ada PID file tapi proses relay jalan, anggap hidup.
if [ "$alive" = "0" ] && pgrep -f "node .*relay.js" >/dev/null 2>&1; then
  alive=1
fi

if [ "$alive" = "1" ]; then
  echo "$(ts) [watchdog] relay hidup, tidak ada tindakan" >> "$LOG_FILE"
  exit 0
fi

echo "$(ts) [watchdog] relay MATI/tidak ditemukan — restart..." >> "$LOG_FILE"
cd "$DIR" || exit 1
# Start detached, log ke relay.log. Mode ikut config.json (dry-run/live).
nohup node relay.js >> "$DIR/data/relay.log" 2>&1 &
NEW_PID=$!
sleep 2
if kill -0 "$NEW_PID" 2>/dev/null; then
  echo "$(ts) [watchdog] relay di-restart (pid $NEW_PID)" >> "$LOG_FILE"
else
  echo "$(ts) [watchdog] GAGAL restart relay (pid $NEW_PID mati dalam 2 dtk — cek data/relay.log)" >> "$LOG_FILE"
  exit 1
fi
