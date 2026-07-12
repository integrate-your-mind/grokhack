#!/usr/bin/env bash
# Restart-loop for one bot pack. Keep argv SHORT so fleet-wide
# `pkill -f agent-bot` thrash from other agents does not kill this loop
# (only the node child matches that pattern; we respawn it).
#
# Usage: run-bot-pack.sh <pack-id>
# Env required: BOT_URL BOT_COUNT BOT_STYLE BOT_NAMES BOT_NAME
# Optional: BOT_CHAT_EVERY BOT_TICK_MS BOT_FORCE_REMOTE extra BOT_*
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACK_ID="${1:-pack}"
LOG="$ROOT/data/fleet/${PACK_ID}.log"
AGENT="$ROOT/scripts/agent-bot.mjs"
mkdir -p "$ROOT/data/fleet"

# soft-default env
export BOT_CHAT_EVERY="${BOT_CHAT_EVERY:-20}"
export BOT_TICK_MS="${BOT_TICK_MS:-320}"

while true; do
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $PACK_ID boot count=${BOT_COUNT:-?} style=${BOT_STYLE:-?} names=${BOT_NAMES:-?}" >>"$LOG"
  # node argv contains agent-bot.mjs (expected). This bash argv does not.
  node "$AGENT" >>"$LOG" 2>&1 || true
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $PACK_ID exited — restart in 4s" >>"$LOG"
  sleep 4
done
