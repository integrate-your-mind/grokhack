#!/usr/bin/env bash
# Durable GrokHack fleet management loop — every 5 minutes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLEET_DIR="${FLEET_DIR:-$ROOT/data/fleet}"
LOG="$FLEET_DIR/manager.log"
INTERVAL_SECONDS="${FLEET_INTERVAL_SECONDS:-300}"
mkdir -p "$FLEET_DIR"

export TMUX=
export FLEET_DIR
export FLEET_INTERVAL_SECONDS="$INTERVAL_SECONDS"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] fleet loop start pid=$$ interval=${INTERVAL_SECONDS}s" >>"$LOG"
while true; do
  {
    echo "----"
    bash "$ROOT/scripts/fleet-manager.sh" once
  } >>"$LOG" 2>&1 || echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] err $?" >>"$LOG"
  sleep "$INTERVAL_SECONDS"
done
