#!/usr/bin/env bash
# bot-fleet-supervisor.sh — always-on multi-pack agent bot fleet for GrokHack.
#
# Keeps 8–12 kind=agent bots online so the dungeon is never empty.
# Owns: data/run/bots-*.pid, data/run/bot-fleet.pid, data/fleet/bots-*.log
# Does NOT touch platform supervisor / server / tunnel.
#
# Usage:
#   bash scripts/bot-fleet-supervisor.sh start|stop|restart|status|ensure
#   npm run agent:fleet
#   npm run agent:fleet:status
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RUN_DIR="$ROOT/data/run"
LOG_DIR="$ROOT/data/fleet"
mkdir -p "$RUN_DIR" "$LOG_DIR"

SELF_PID_FILE="$RUN_DIR/bot-fleet.pid"
SELF_LOG="$LOG_DIR/bot-fleet-supervisor.log"
AGENT_BOT="$ROOT/scripts/agent-bot.mjs"

# Target headcount: 10 bots across 3 packs (platform may add ~2 GrokBots → ≤12).
# Override pack sizes with BOT_FLEET_LOCAL / BOT_FLEET_CAREFUL / BOT_FLEET_DIEHARD.
LOCAL_N="${BOT_FLEET_LOCAL:-4}"
CAREFUL_N="${BOT_FLEET_CAREFUL:-4}"
DIEHARD_N="${BOT_FLEET_DIEHARD:-2}"
POLL_SEC="${BOT_FLEET_POLL_SEC:-12}"
LOCAL_WS="${BOT_FLEET_LOCAL_URL:-ws://127.0.0.1:8080/ws}"
# Prod pack prefers remote so tunnel-only hosts still see bots; co-located agent-bot
# auto-falls back to local unless BOT_FORCE_REMOTE=1.
PROD_WS="${BOT_FLEET_PROD_URL:-wss://grokhack.mondello.dev/ws}"

log() {
  local line="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
  echo "$line" | tee -a "$SELF_LOG"
}

is_pid_alive() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

is_running() {
  local f="$1"
  [[ -f "$f" ]] || return 1
  is_pid_alive "$(cat "$f" 2>/dev/null || true)"
}

stop_pid_file() {
  local f="$1"
  local label="${2:-proc}"
  if [[ ! -f "$f" ]]; then
    return 0
  fi
  local pid
  pid="$(cat "$f" 2>/dev/null || true)"
  if is_pid_alive "$pid"; then
    log "Stopping $label pid=$pid"
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      is_pid_alive "$pid" || break
      sleep 0.3
    done
    if is_pid_alive "$pid"; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$f"
}

server_ok() {
  curl -sf --max-time 2 "http://127.0.0.1:8080/api/status" >/dev/null 2>&1 \
    || curl -sf --max-time 3 "https://grokhack.mondello.dev/api/status" >/dev/null 2>&1
}

online_players() {
  local body
  body="$(curl -sf --max-time 2 "http://127.0.0.1:8080/api/status" 2>/dev/null \
    || curl -sf --max-time 3 "https://grokhack.mondello.dev/api/status" 2>/dev/null \
    || echo '{}')"
  node -e 'try{const j=JSON.parse(process.argv[1]);process.stdout.write(String(j.onlinePlayers??"?"))}catch{process.stdout.write("?")}' "$body"
}

# --- pack definitions -------------------------------------------------------
# Each pack: id|count|style|names|url|extra_env
pack_defs() {
  cat <<EOF
bots-local|${LOCAL_N}|reckless|Ash,Bram,Cinder,Drake|${LOCAL_WS}|
bots-careful|${CAREFUL_N}|careful|Sage,Wisp,Quill,Vale|${LOCAL_WS}|
bots-diehard|${DIEHARD_N}|reckless|Hex,Flint|${PROD_WS}|BOT_FORCE_REMOTE=0
EOF
}

start_pack() {
  local id="$1" count="$2" style="$3" names="$4" url="$5" extra="${6:-}"
  local pid_file="$RUN_DIR/${id}.pid"
  local log_file="$LOG_DIR/${id}.log"

  if [[ "$count" -le 0 ]]; then
    return 0
  fi
  if is_running "$pid_file"; then
    return 0
  fi
  stop_pid_file "$pid_file" "$id"

  if ! server_ok; then
    log "WARN: server not healthy — defer start of $id"
    return 1
  fi

  log "Starting pack $id count=$count style=$style names=$names url=$url"
  # Short argv via run-bot-pack.sh — survives other agents' pkill -f agent-bot thrash
  # shellcheck disable=SC2086
  nohup env \
    BOT_URL="$url" \
    BOT_COUNT="$count" \
    BOT_STYLE="$style" \
    BOT_NAMES="$names" \
    BOT_NAME="$(echo "$names" | cut -d, -f1)" \
    BOT_CHAT_EVERY="${BOT_CHAT_EVERY:-20}" \
    BOT_TICK_MS="${BOT_TICK_MS:-320}" \
    $extra \
    bash "$ROOT/scripts/run-bot-pack.sh" "$id" \
    >/dev/null 2>&1 &
  echo $! >"$pid_file"
  log "Pack $id supervisor pid=$(cat "$pid_file")"
}

ensure_packs() {
  local line id count style names url extra
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    IFS='|' read -r id count style names url extra <<<"$line"
    if ! is_running "$RUN_DIR/${id}.pid"; then
      log "Pack dead: $id — restarting"
      start_pack "$id" "$count" "$style" "$names" "$url" "$extra" || true
    fi
  done < <(pack_defs)
}

stop_packs() {
  local line id
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    id="${line%%|*}"
    stop_pid_file "$RUN_DIR/${id}.pid" "$id"
  done < <(pack_defs)
  # Legacy ad-hoc PIDs from earlier fleets
  stop_pid_file "$RUN_DIR/bots-prod.pid" "bots-prod"
}

start_all() {
  local line id count style names url extra
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    IFS='|' read -r id count style names url extra <<<"$line"
    start_pack "$id" "$count" "$style" "$names" "$url" "$extra" || true
  done < <(pack_defs)
}

cmd_start() {
  if is_running "$SELF_PID_FILE"; then
    log "Fleet supervisor already running pid=$(cat "$SELF_PID_FILE")"
    ensure_packs
    cmd_status
    return 0
  fi
  # Reclaim stale self pid
  rm -f "$SELF_PID_FILE"

  log "Starting bot-fleet supervisor (local=$LOCAL_N careful=$CAREFUL_N diehard=$DIEHARD_N)"
  start_all

  # Detached ensure-loop (nohup so it survives the hiring shell exit)
  nohup bash -c "
    cd $(printf %q "$ROOT")
    echo \$\$ > $(printf %q "$SELF_PID_FILE")
    echo \"[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] Fleet supervisor loop pid=\$\$ poll=${POLL_SEC}s\" >> $(printf %q "$SELF_LOG")
    while true; do
      bash $(printf %q "$ROOT/scripts/bot-fleet-supervisor.sh") ensure-quiet || true
      sleep ${POLL_SEC}
    done
  " >>"$SELF_LOG" 2>&1 &
  sleep 0.6
  cmd_status
}

cmd_stop() {
  log "Stopping bot fleet…"
  stop_pid_file "$SELF_PID_FILE" "bot-fleet-supervisor"
  stop_packs
  # Do NOT kill platform agent-bot.pid (grokhack-supervisor owns it)
  log "Fleet stopped"
  cmd_status
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_ensure() {
  if is_running "$SELF_PID_FILE"; then
    ensure_packs
  else
    cmd_start
  fi
  cmd_status
}

# Internal: only restart dead packs (used by the detached ensure-loop).
cmd_ensure_quiet() {
  ensure_packs
}

# Status without noisy pgrep of unrelated shells
cmd_status() {
  echo "=== bot fleet status ==="
  echo "onlinePlayers=$(online_players)"
  local line id count style names url extra pid_file pid st
  local total=0
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    IFS='|' read -r id count style names url extra <<<"$line"
    pid_file="$RUN_DIR/${id}.pid"
    total=$((total + count))
    if is_running "$pid_file"; then
      pid="$(cat "$pid_file")"
      st="UP pid=$pid"
    else
      st="DOWN"
    fi
    printf "  %-14s n=%-2s style=%-8s %s names=%s\n" "$id" "$count" "$style" "$st" "$names"
  done < <(pack_defs)
  echo "target_bots=$total (plus optional platform agent-bot)"
  if is_running "$SELF_PID_FILE"; then
    echo "supervisor=UP pid=$(cat "$SELF_PID_FILE")"
  else
    echo "supervisor=DOWN"
  fi
  if [[ -f "$RUN_DIR/agent-bot.pid" ]] && is_running "$RUN_DIR/agent-bot.pid"; then
    echo "platform_agent_bot=UP pid=$(cat "$RUN_DIR/agent-bot.pid") (owned by grokhack-supervisor)"
  else
    echo "platform_agent_bot=DOWN_or_absent"
  fi
  echo "logs: $LOG_DIR/bots-*.log  runs: $LOG_DIR/bot-runs.jsonl"
  echo "--- node agent-bot processes ---"
  # Match node only (avoid zsh/bash one-liners that embed agent-bot.mjs in argv)
  ps -ax -o pid=,command= 2>/dev/null | awk '/node.*agent-bot\.mjs/ && !/awk/ {print}' || echo "(none)"
}

case "${1:-status}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_restart ;;
  ensure) cmd_ensure ;;
  ensure-quiet) cmd_ensure_quiet ;;
  status) cmd_status ;;
  *)
    echo "Usage: $0 start|stop|restart|status|ensure" >&2
    exit 2
    ;;
esac
