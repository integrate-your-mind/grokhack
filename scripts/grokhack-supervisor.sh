#!/usr/bin/env bash
# GrokHack production supervisor - keeps game server + Cloudflare tunnel alive.
# Used by launchd (npm run prod:install) or run directly: npm run prod
#
# Design goals (PLATFORM/SRE):
# - :8080 stays up across restarts when a healthy listener already exists (adopt)
# - brief health blips do not thrash the world (consecutive-failure gate)
# - process-group cleanup so orphans do not hold the port
# - tunnel always targets 127.0.0.1 (never localhost/IPv6)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# /usr/sbin required for lsof on macOS (launchd default PATH omits it).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/usr/bin:/bin:${PATH:-}"
export BIND_HOST="${BIND_HOST:-127.0.0.1}"
export PORT="${PORT:-8080}"
export TUNNEL_ID="${TUNNEL_ID:-48eb2839-41c7-426b-9bed-8cce35b7b545}"

# This launcher owns the public/tunnel runtime boundary. Force production
# semantics even when an interactive shell or the local .env says otherwise,
# and prevent the development payment secret from entering public children.
export NODE_ENV=production
export GROKHACK_ENV=production
export X402_FORCE_PROD=1

# launchd/interactive shells can carry unrelated developer-agent credentials.
# The game loads project-specific .env values; never propagate unrelated workstation
# provider keys into long-lived public service children.
for inherited_secret in \
  ARISTOTLE_API_KEY BANKR_API_KEY GROQ_GATEWAY_TOKEN HONCHO_API_KEY \
  KIMI_API_KEY KIMI_GATEWAY_TOKEN LM_STUDIO_API_KEY MINIMAX_API_KEY \
  MINIMAX_GATEWAY_TOKEN STARSHIP_SESSION_KEY TENDERLY_API_KEY; do
  unset "$inherited_secret"
done

LOG_DIR="$ROOT/data/logs"
RUN_DIR="$ROOT/data/run"
mkdir -p "$LOG_DIR" "$RUN_DIR"

SERVER_LOG="$LOG_DIR/server.log"
TUNNEL_LOG="$LOG_DIR/tunnel.log"
AGENT_LOG="$LOG_DIR/agent-bot.log"
SUP_LOG="$LOG_DIR/supervisor.log"
SERVER_PID_FILE="$RUN_DIR/server.pid"
TUNNEL_PID_FILE="$RUN_DIR/tunnel.pid"
AGENT_PID_FILE="$RUN_DIR/agent-bot.pid"
SUP_PID_FILE="$RUN_DIR/supervisor.pid"

HEALTH_INTERVAL="${HEALTH_INTERVAL:-20}"
# Require N consecutive failed health checks before hard-restarting the server wrapper.
# Inner restart loop recovers most crashes in ~3s; this avoids thrashing live sessions.
# Raised to 3 so brief blips / agent load do not SIGTERM the world.
HEALTH_FAIL_THRESHOLD="${HEALTH_FAIL_THRESHOLD:-3}"
SERVER_RESTART_DELAY="${SERVER_RESTART_DELAY:-3}"
SERVER_RESTART_MAX_DELAY="${SERVER_RESTART_MAX_DELAY:-60}"
SERVER_STABLE_RUNTIME="${SERVER_STABLE_RUNTIME:-60}"
SERVER_STOP_GRACE_SECONDS="${SERVER_STOP_GRACE_SECONDS:-100}"
TUNNEL_RESTART_DELAY="${TUNNEL_RESTART_DELAY:-5}"
# Minimum seconds between free_port hard restarts (even after threshold).
MIN_HARD_RESTART_GAP="${MIN_HARD_RESTART_GAP:-120}"
LAST_HARD_RESTART=0
# Keep the live world populated with kind=agent bots (0 disables).
AGENT_BOT_COUNT="${AGENT_BOT_COUNT:-2}"
AGENT_BOT_NAME="${AGENT_BOT_NAME:-GrokBot}"
AGENT_BOT_URL="${AGENT_BOT_URL:-wss://grokhack.mondello.dev/ws}"

HEALTH_FAILS=0

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$SUP_LOG"
}

is_running() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [[ -n "$pid" && "$pid" != "0" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

# Kill a pid and its process group (children of the restart wrapper).
stop_pid_file() {
  local pid_file="$1"
  local name="$2"
  local grace_seconds="${3:-5}"
  if ! [[ -f "$pid_file" ]]; then
    return 0
  fi
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -n "${pid:-}" && "$pid" != "0" ]] && kill -0 "$pid" 2>/dev/null; then
    log "Stopping $name (pid $pid)..."
    local pgid
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    # Prefer process-group signal so npm/tsx/node children die with the wrapper.
    # Never signal pgid 0/1 (system).
    if [[ -n "${pgid:-}" && "$pgid" != "0" && "$pgid" != "1" && "$pgid" != "$$" ]]; then
      # Only kill the group if it is not the supervisor's own group (shared PGID under launchd).
      if [[ "$pgid" != "$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')" ]]; then
        kill -- "-$pgid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      else
        kill "$pid" 2>/dev/null || true
      fi
    else
      kill "$pid" 2>/dev/null || true
    fi
    local i
    for ((i = 0; i < grace_seconds; i += 1)); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$pid" 2>/dev/null || true
    # Best-effort: also reap direct children of the wrapper
    pkill -P "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

port_listener_pids() {
  # macOS: -nP avoids DNS hangs; -t is terse PIDs. Fall back to bare -i.
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null \
    || lsof -nP -i ":${PORT}" -sTCP:LISTEN -t 2>/dev/null \
    || true
}

# True if PID looks like our game server (not a random :PORT holder).
is_our_server_pid() {
  local pid="$1"
  [[ -n "$pid" && "$pid" != "0" ]] || return 1
  local cmd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ -n "$cmd" ]] || return 1
  # Match tsx/node game entrypoints used by this repo.
  if [[ "$cmd" == *"server/index.ts"* || "$cmd" == *"tsx"*server* || "$cmd" == *"node"*server/index* ]]; then
    return 0
  fi
  # npx tsx parent often shows as "npm exec tsx" / "node .../tsx"
  if [[ "$cmd" == *"tsx"* && "$cmd" == *"server"* ]]; then
    return 0
  fi
  return 1
}

# Only free the port when we are intentionally replacing a dead/unhealthy service.
# Never call this while server_healthy is true.
# Never kill foreign listeners (P1 free_port safety) unless FREE_PORT_FORCE=1.
# NO_RESTART blocks killing a healthy world; unhealthy recovery still allowed.
free_port() {
  if server_healthy; then
    log "Refusing free_port - server is healthy (would drop live sessions)"
    return 1
  fi
  if [[ -f "$RUN_DIR/NO_RESTART" ]]; then
    log "NO_RESTART set - free_port only if no healthy status (origin is down)"
  fi
  local pids pid safe_pids="" foreign=0
  pids="$(port_listener_pids)"
  if [[ -z "$pids" ]]; then
    return 0
  fi
  for pid in $pids; do
    if is_our_server_pid "$pid" || [[ "${FREE_PORT_FORCE:-0}" == "1" ]]; then
      safe_pids="${safe_pids}${safe_pids:+ }$pid"
    else
      foreign=1
      log "WARN: free_port skipping foreign listener pid=$pid cmd=$(ps -p "$pid" -o command= 2>/dev/null | head -c 120)"
    fi
  done
  if [[ "$foreign" -eq 1 && -z "$safe_pids" ]]; then
    log "ERROR: port ${PORT} held by foreign process(es); set FREE_PORT_FORCE=1 to override"
    return 1
  fi
  if [[ -n "$safe_pids" ]]; then
    log "Freeing port ${PORT} from stale listener(s): $safe_pids"
    printf '[%s] free_port pids=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$safe_pids" >> "$LOG_DIR/reloads.log"
    # shellcheck disable=SC2086
    kill $safe_pids 2>/dev/null || true
    for pid in $safe_pids; do
      local waited
      for ((waited = 0; waited < SERVER_STOP_GRACE_SECONDS; waited += 1)); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    done
  fi
}

server_healthy() {
  local health
  health="$(curl -sf --max-time 5 "http://127.0.0.1:${PORT}/health?format=json" 2>/dev/null || true)"
  [[ "$health" == *'"ok":true'* && "$health" == *'"ready":true'* && "$health" == *'"productionSafe":true'* ]]
}

# A replacement wrapper can outlive the process it originally launched. If a
# verified server already owns the port (for example after an older wrapper was
# orphaned), do not hammer DuckDB and the CPU with doomed restart attempts.
server_process_needed() {
  ! server_healthy
}

server_restart_backoff_seconds() {
  local failures="${1:-1}"
  if ! [[ "$failures" =~ ^[0-9]+$ ]] || [[ "$failures" -lt 1 ]]; then
    failures=1
  fi

  local delay="$SERVER_RESTART_DELAY"
  local i
  for ((i = 1; i < failures; i += 1)); do
    if [[ "$delay" -ge "$SERVER_RESTART_MAX_DELAY" ]]; then
      delay="$SERVER_RESTART_MAX_DELAY"
      break
    fi
    delay=$((delay * 2))
    if [[ "$delay" -gt "$SERVER_RESTART_MAX_DELAY" ]]; then
      delay="$SERVER_RESTART_MAX_DELAY"
      break
    fi
  done
  printf '%s\n' "$delay"
}

run_server_process_once() {
  "$ROOT/node_modules/.bin/tsx" server/index.ts >> "$SERVER_LOG" 2>&1
}

run_server_wrapper() {
  local failures=0
  local idle_logged=0
  while true; do
    if ! server_process_needed; then
      failures=0
      if [[ "$idle_logged" -eq 0 ]]; then
        echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] wrapper idle - verified server already owns ${BIND_HOST}:${PORT}" >> "$SERVER_LOG"
        idle_logged=1
      fi
      sleep "$HEALTH_INTERVAL"
      continue
    fi

    idle_logged=0
    local started_at exit_code=0 runtime delay
    started_at="$(date +%s)"
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] server boot" >> "$SERVER_LOG"
    run_server_process_once || exit_code=$?
    runtime=$(($(date +%s) - started_at))

    if [[ "$runtime" -ge "$SERVER_STABLE_RUNTIME" ]]; then
      failures=1
    else
      failures=$((failures + 1))
    fi
    delay="$(server_restart_backoff_seconds "$failures")"
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] server exited code=${exit_code} runtime=${runtime}s - restart in ${delay}s" >> "$SERVER_LOG"
    sleep "$delay"
  done
}

# If something already answers /api/status, adopt it - do not kill the world.
adopt_healthy_server() {
  if ! server_healthy; then
    return 1
  fi
  if is_running "$SERVER_PID_FILE"; then
    log "Game server already supervised and healthy (wrapper pid $(cat "$SERVER_PID_FILE"))"
    return 0
  fi
  local listen_pid
  listen_pid="$(port_listener_pids | awk 'NR==1{print; exit}')"
  if [[ -n "${listen_pid:-}" ]]; then
    echo "$listen_pid" > "$SERVER_PID_FILE"
    log "Adopting healthy server already on :${PORT} (listener pid $listen_pid) - not killing"
  else
    log "Adopting healthy server on :${PORT}"
    # Marker only - is_running treats 0 as not running so health loop still works via server_healthy
    rm -f "$SERVER_PID_FILE"
  fi
  return 0
}

start_server() {
  # Critical: never free_port / kill when healthy.
  if server_healthy; then
    adopt_healthy_server || true
    return 0
  fi

  local now
  now="$(date +%s)"
  if [[ "$LAST_HARD_RESTART" -gt 0 ]]; then
    local gap=$((now - LAST_HARD_RESTART))
    if [[ "$gap" -lt "${MIN_HARD_RESTART_GAP}" ]]; then
      log "Hard-restart rate limit (${gap}s < ${MIN_HARD_RESTART_GAP}s) - waiting for inner loop / next check"
      return 1
    fi
  fi
  LAST_HARD_RESTART=$now

  # Unhealthy or missing - replace wrapper + free stale holder.
  stop_pid_file "$SERVER_PID_FILE" "server" "$SERVER_STOP_GRACE_SECONDS"
  free_port || true

  log "Starting game server on ${BIND_HOST}:${PORT}..."
  run_server_wrapper &
  echo $! > "$SERVER_PID_FILE"

  local i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if server_healthy; then
      log "Game server healthy (wrapper pid $(cat "$SERVER_PID_FILE"))"
      HEALTH_FAILS=0
      return 0
    fi
    sleep 1
  done
  log "WARN: game server health check failed after start"
  return 1
}

public_edge_healthy() {
  curl -sf --max-time 8 "https://grokhack.mondello.dev/health" >/dev/null 2>&1 \
    || curl -sf --max-time 8 "https://grokhack.mondello.dev/api/status" >/dev/null 2>&1
}

TUNNEL_CONFIG="${TUNNEL_CONFIG:-$ROOT/cloudflare/grokhack-tunnel.yml}"

# Refuse configs that point at empty/wrong origin or open localhost IPv6 split.
tunnel_config_safe() {
  local cfg="$1"
  if [[ ! -f "$cfg" ]]; then
    log "ERROR: tunnel config missing: $cfg"
    return 1
  fi
  # Must pin 127.0.0.1 (not localhost → [::1] when game binds IPv4-only).
  if ! grep -qE 'service:\s*http://127\.0\.0\.1:' "$cfg"; then
    log "ERROR: tunnel config must use service: http://127.0.0.1:${PORT} (got unsafe origin in $cfg)"
    return 1
  fi
  if grep -qE 'service:\s*http://localhost' "$cfg"; then
    log "ERROR: tunnel config uses localhost (IPv6 split-brain risk)"
    return 1
  fi
  # Telnet must never be ingress.
  if grep -qE 'service:.*:4000' "$cfg"; then
    log "ERROR: tunnel config must not expose telnet :4000"
    return 1
  fi
  return 0
}

# Split-brain: same Cloudflare tunnel id must not have a second live origin (k8s).
# Detect scaled k8s tunnel pods; refuse unless ALLOW_DUAL_ORIGIN=1.
k8s_tunnel_conflict() {
  if [[ "${ALLOW_DUAL_ORIGIN:-0}" == "1" ]]; then
    return 1
  fi
  command -v kubectl >/dev/null 2>&1 || return 1
  local ready
  ready="$(kubectl -n grokhack get deploy grokhack-tunnel -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)"
  if [[ -n "${ready:-}" && "$ready" != "0" && "$ready" != "<none>" ]]; then
    log "ERROR: k8s grokhack-tunnel readyReplicas=$ready — dual-origin split-brain risk for tunnel ${TUNNEL_ID}"
    log "Stop k8s tunnels OR host tunnels; set ALLOW_DUAL_ORIGIN=1 only for intentional migration."
    return 0
  fi
  return 1
}

# Dual cloudflared connectors under one wrapper (Cloudflare HA)
start_tunnel() {
  if ! tunnel_config_safe "$TUNNEL_CONFIG"; then
    log "Refusing to start tunnel — unsafe config"
    return 1
  fi
  if k8s_tunnel_conflict; then
    log "Refusing to start host tunnel while k8s tunnel is live"
    return 1
  fi
  if is_running "$TUNNEL_PID_FILE"; then
    # Still bounce if public edge dead while origin healthy (stale tunnel)
    if server_healthy && ! public_edge_healthy; then
      log "Public edge down while origin healthy - bouncing tunnel"
      stop_pid_file "$TUNNEL_PID_FILE" "tunnel"
    else
      return 0
    fi
  fi
  stop_pid_file "$TUNNEL_PID_FILE" "tunnel"

  # Never attach CF edge to empty/untrusted origin.
  if ! server_healthy; then
    log "WARN: origin not healthy — delaying tunnel start until /api/status is up"
    local w
    for w in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
      server_healthy && break
      sleep 1
    done
    if ! server_healthy; then
      log "ERROR: refusing tunnel start — origin still down (would publish empty edge)"
      return 1
    fi
  fi

  log "Starting Cloudflare tunnel ${TUNNEL_ID} (dual connectors)..."
  local TUNNEL_LOG_B="$LOG_DIR/tunnel-b.log"
  (
    start_cf() {
      local tag="$1" logf="$2"
      (
        while true; do
          echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] tunnel boot tag=${tag}" >> "$logf"
          local w
          for w in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
            curl -sf --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
            sleep 1
          done
          if ! curl -sf --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
            echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] tunnel tag=${tag} skip run — origin unhealthy" >> "$logf"
            sleep "${TUNNEL_RESTART_DELAY}"
            continue
          fi
          cloudflared tunnel --config "$TUNNEL_CONFIG" run "${TUNNEL_ID}" >> "$logf" 2>&1 || true
          echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] tunnel exited tag=${tag} - restart in ${TUNNEL_RESTART_DELAY}s" >> "$logf"
          sleep "${TUNNEL_RESTART_DELAY}"
        done
      ) &
      echo $!
    }
    local pid_a pid_b
    pid_a=$(start_cf a "$TUNNEL_LOG")
    pid_b=$(start_cf b "$TUNNEL_LOG_B")
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] dual tunnel a=$pid_a b=$pid_b" >> "$TUNNEL_LOG"
    while true; do
      if ! kill -0 "$pid_a" 2>/dev/null; then
        pid_a=$(start_cf a "$TUNNEL_LOG")
      fi
      if ! kill -0 "$pid_b" 2>/dev/null; then
        pid_b=$(start_cf b "$TUNNEL_LOG_B")
      fi
      sleep 15
    done
  ) &
  echo $! > "$TUNNEL_PID_FILE"
  log "Tunnel supervisor started (pid $(cat "$TUNNEL_PID_FILE")) dual connectors"
}

start_agent_bots() {
  if [[ "${AGENT_BOT_COUNT}" -le 0 ]]; then
    return 0
  fi
  if is_running "$AGENT_PID_FILE"; then
    return 0
  fi
  stop_pid_file "$AGENT_PID_FILE" "agent-bot"

  if ! server_healthy; then
    return 1
  fi

  log "Starting agent bot fleet (count=${AGENT_BOT_COUNT} name=${AGENT_BOT_NAME})..."
  (
    while true; do
      echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] agent-bot boot count=${AGENT_BOT_COUNT}" >> "$AGENT_LOG"
      BOT_URL="${AGENT_BOT_URL}" BOT_NAME="${AGENT_BOT_NAME}" BOT_COUNT="${AGENT_BOT_COUNT}" \
        node scripts/agent-bot.mjs >> "$AGENT_LOG" 2>&1 || true
      echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] agent-bot exited - restart in 5s" >> "$AGENT_LOG"
      sleep 5
    done
  ) &
  echo $! > "$AGENT_PID_FILE"
  log "Agent bot supervisor started (pid $(cat "$AGENT_PID_FILE"))"
}

ensure_side_processes() {
  # Ongoing dual-origin detection (k8s tunnel scaled up while host tunnel lives).
  if is_running "$TUNNEL_PID_FILE" && k8s_tunnel_conflict; then
    log "CRITICAL: dual-origin detected — stopping host tunnel connectors (set ALLOW_DUAL_ORIGIN=1 to keep both)"
    stop_pid_file "$TUNNEL_PID_FILE" "tunnel"
    return 0
  fi
  if ! is_running "$TUNNEL_PID_FILE"; then
    log "Tunnel supervisor dead - restarting"
    start_tunnel || true
  elif server_healthy && ! public_edge_healthy; then
    log "Public edge unhealthy - bouncing tunnel connectors"
    start_tunnel || true
  fi
  if [[ "${AGENT_BOT_COUNT}" -gt 0 ]] && ! is_running "$AGENT_PID_FILE"; then
    log "Agent bot supervisor dead - restarting"
    start_agent_bots || true
  fi
}

shutdown() {
  log "Supervisor shutting down..."
  stop_pid_file "$AGENT_PID_FILE" "agent-bot"
  stop_pid_file "$TUNNEL_PID_FILE" "tunnel"
  stop_pid_file "$SERVER_PID_FILE" "server" "$SERVER_STOP_GRACE_SECONDS"
  rm -f "$SUP_PID_FILE"
  exit 0
}

# Allows executable policy tests to source the functions without launching or
# signalling any production processes.
if [[ "${GROKHACK_SUPERVISOR_LIBRARY_ONLY:-0}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

trap shutdown INT TERM

if [[ -f "$SUP_PID_FILE" ]]; then
  existing="$(cat "$SUP_PID_FILE" 2>/dev/null || true)"
  if [[ -n "$existing" && "$existing" != "$$" ]] && kill -0 "$existing" 2>/dev/null; then
    log "Another supervisor already running (pid $existing). Exiting."
    exit 1
  fi
fi
echo $$ > "$SUP_PID_FILE"

log "GrokHack supervisor started (pid $$)"
start_server
start_tunnel
start_agent_bots || log "WARN: agent bots not started yet (will retry)"

while true; do
  if server_healthy; then
    HEALTH_FAILS=0
    if ! is_running "$SERVER_PID_FILE"; then
      adopt_healthy_server || true
    fi
  else
    HEALTH_FAILS=$((HEALTH_FAILS + 1))
    log "Health check failed ($HEALTH_FAILS/${HEALTH_FAIL_THRESHOLD})"
    if [[ "$HEALTH_FAILS" -ge "${HEALTH_FAIL_THRESHOLD}" ]]; then
      log "Health failure threshold reached - restarting game server"
      start_server || true
      HEALTH_FAILS=0
    fi
  fi

  ensure_side_processes
  sleep "${HEALTH_INTERVAL}"
done
