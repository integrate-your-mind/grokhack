#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

export BIND_HOST="${BIND_HOST:-127.0.0.1}"
export PORT="${PORT:-8080}"

echo "[prod] BIND_HOST=$BIND_HOST PORT=$PORT"
echo "[prod] Starting game server…"
PORT=$PORT BIND_HOST=$BIND_HOST npx tsx server/index.ts &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

sleep 2
if ! curl -sf "http://127.0.0.1:$PORT/api/status" >/dev/null; then
  echo "[prod] Server failed health check" >&2
  kill "$SERVER_PID" 2>/dev/null || true
  exit 1
fi

echo "[prod] Starting Cloudflare tunnel (auto-restart on crash)…"
while true; do
  cloudflared tunnel --config cloudflare/grokhack-tunnel.yml run 48eb2839-41c7-426b-9bed-8cce35b7b545 || true
  echo "[prod] Tunnel exited — restarting in 5s…" >&2
  sleep 5
done