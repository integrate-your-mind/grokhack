#!/usr/bin/env bash
# GrokHack deploy — tests, optional static Pages mirror, ensure supervisor is healthy.
# Does NOT thrash a healthy :8080. Soft-reloads are gated (players + rate limit).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MODE="${1:-status}"  # status | soft | pages | full | ensure
FORCE="${FORCE:-0}"
RUN_DIR="$ROOT/data/run"
LOG_DIR="$ROOT/data/logs"
RELOAD_STAMP="$RUN_DIR/last-soft-reload"
RELOAD_LOG="$LOG_DIR/reloads.log"
PAGES_PRODUCTION_BRANCH="${PAGES_PRODUCTION_BRANCH:-main}"
MIN_RELOAD_GAP_SEC="${MIN_RELOAD_GAP_SEC:-600}"  # 10 minutes
RELOAD_RECOVERY_TIMEOUT_SEC="${RELOAD_RECOVERY_TIMEOUT_SEC:-130}"

mkdir -p "$RUN_DIR" "$LOG_DIR"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/usr/bin:/bin:${PATH:-}"

log() { printf '==> %s\n' "$*"; }

audit_reload() {
  printf '[%s] %s force=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" "$FORCE" >> "$RELOAD_LOG"
}

health_local() {
  local health
  health="$(curl -sf --max-time 5 "http://127.0.0.1:8080/health?format=json" 2>/dev/null || true)"
  [[ "$health" == *'"ok":true'* && "$health" == *'"ready":true'* && "$health" == *'"productionSafe":true'* ]]
}

health_prod() {
  local health
  health="$(curl -sf --max-time 8 "https://grokhack.mondello.dev/health?format=json" 2>/dev/null || true)"
  [[ "$health" == *'"ok":true'* && "$health" == *'"ready":true'* && "$health" == *'"productionSafe":true'* ]]
}

origin_local_responding() {
  local health
  health="$(curl -sf --max-time 5 "http://127.0.0.1:8080/health?format=json" 2>/dev/null || true)"
  [[ "$health" == *'"ok":true'* ]]
}

run_release_gates() {
  # Canonical free CI — never GitHub-hosted Actions (billing lock / $0 policy).
  log "Running release gates via local CI"
  npm run ci
}

deploy_pages() {
  local wrangler="$ROOT/edge/node_modules/.bin/wrangler"
  if [[ ! -x "$wrangler" ]]; then
    log "ERROR: pinned Wrangler missing at $wrangler (run npm --prefix edge ci)"
    return 1
  fi
  local branch sha remote_sha archive_dir rc
  branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [[ "$branch" != "$PAGES_PRODUCTION_BRANCH" ]]; then
    log "ERROR: production Pages deploy requires branch $PAGES_PRODUCTION_BRANCH (current: ${branch:-detached})."
    return 1
  fi
  sha="$(git rev-parse --verify HEAD)"
  remote_sha="$(git ls-remote --exit-code origin "refs/heads/$PAGES_PRODUCTION_BRANCH" 2>/dev/null | awk 'NR == 1 { print $1 }')"
  if [[ -z "$remote_sha" || "$sha" != "$remote_sha" ]]; then
    log "ERROR: HEAD $sha is not the exact pushed origin/$PAGES_PRODUCTION_BRANCH revision."
    return 1
  fi

  archive_dir="$(mktemp -d "${TMPDIR:-/tmp}/grokhack-pages.XXXXXX")"
  if ! git archive "$sha" public | tar -x -C "$archive_dir"; then
    rm -rf "$archive_dir"
    log "ERROR: could not materialize public/ from commit $sha"
    return 1
  fi
  if "$wrangler" pages deploy "$archive_dir/public" \
    --project-name grokhack \
    --branch "$PAGES_PRODUCTION_BRANCH" \
    --commit-hash "$sha" \
    --commit-dirty=false; then
    rc=0
  else
    rc=$?
  fi
  rm -rf "$archive_dir"
  return "$rc"
}

safe_process_list() {
  local found=0 spec label pattern pid
  for spec in \
    "supervisor|grokhack-supervisor" \
    "game-server|tsx server/index" \
    "cloudflare-tunnel|cloudflared.*grokhack" \
    "agent-bot|agent-bot"; do
    label="${spec%%|*}"
    pattern="${spec#*|}"
    while IFS= read -r pid; do
      [[ -n "$pid" && "$pid" != "$$" ]] || continue
      printf '%s %s\n' "$pid" "$label"
      found=1
    done < <(pgrep -f "$pattern" 2>/dev/null || true)
  done
  [[ "$found" -eq 1 ]] || echo "none"
}

status_json() {
  curl -sf --max-time 5 "http://127.0.0.1:8080/api/status" 2>/dev/null
}

online_players() {
  local status n
  status="$(status_json)" || return 1
  n="$(printf '%s\n' "$status" | sed -n 's/.*"onlinePlayers"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1)"
  [[ "$n" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$n"
}

print_status() {
  log "local :8080"
  if health_local; then
    curl -sf --max-time 5 "http://127.0.0.1:8080/api/status" | head -c 280
    echo
  else
    echo "DOWN"
  fi
  log "prod grokhack.mondello.dev"
  if health_prod; then
    curl -sf --max-time 8 "https://grokhack.mondello.dev/api/status" | head -c 280
    echo
  else
    echo "DOWN"
  fi
  log "processes"
  safe_process_list
}

seconds_since_reload() {
  if [[ ! -f "$RELOAD_STAMP" ]]; then
    echo 999999
    return
  fi
  local then now
  then="$(cat "$RELOAD_STAMP" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  echo $((now - then))
}

# Refuse soft reload when world is live unless FORCE=1.
# Rate-limit to MIN_RELOAD_GAP_SEC even with FORCE=0 path (FORCE=1 still rate-limits unless FORCE=2).
guard_soft_reload() {
  if [[ -f "$RUN_DIR/NO_RESTART" && "$FORCE" != "1" && "$FORCE" != "2" ]]; then
    log "BLOCKED: data/run/NO_RESTART present (stability freeze). Use FORCE=1 to override."
    audit_reload "blocked NO_RESTART"
    return 1
  fi

  local n
  if ! n="$(online_players)"; then
    log "BLOCKED: online player count unavailable — refusing blind soft-reload."
    audit_reload "blocked player_status_unavailable"
    return 1
  fi
  if [[ "$n" -gt 0 && "$FORCE" != "1" && "$FORCE" != "2" ]]; then
    log "BLOCKED: onlinePlayers=$n — refusing SIGTERM soft-reload (stable connections priority)."
    log "  Code still ships on disk; clients reconnect / cache-bust. Override: FORCE=1 $0 soft"
    log "  See data/fleet/OWNERSHIP.md"
    audit_reload "blocked onlinePlayers=$n"
    return 1
  fi

  local ago
  ago="$(seconds_since_reload)"
  if [[ "$ago" -lt "$MIN_RELOAD_GAP_SEC" && "$FORCE" != "2" ]]; then
    log "BLOCKED: last soft-reload ${ago}s ago (min gap ${MIN_RELOAD_GAP_SEC}s). Override: FORCE=2 $0 soft"
    audit_reload "blocked rate_limit ago=${ago}s"
    return 1
  fi
  return 0
}

# Soft reload: signal only the node game process. Supervisor restart loop brings it back.
soft_reload_server() {
  if ! guard_soft_reload; then
    return 1
  fi

  log "Soft-reloading game server (keep tunnel + supervisor) FORCE=$FORCE"
  audit_reload "soft_reload start"
  date +%s > "$RELOAD_STAMP"

  if ! origin_local_responding; then
    # DOWN — ensure is the right path, not kill
    log "Server unhealthy — ensuring supervisor (no gratuitous kill)"
    bash "$ROOT/scripts/install-service.sh" install
    sleep 2
    if health_local; then
      return 0
    fi
    log "ERROR: server remains unhealthy after supervisor ensure"
    return 1
  fi

  local pids
  pids="$(lsof -nP -iTCP:8080 -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    log "SIGTERM listeners on :8080: $pids"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
  else
    # Avoid broad pkill -f (matches tooling); target node server only if we can
    local node_pids
    node_pids="$(ps -axo pid=,command= | awk '/node.*server\/index\.ts/ && !/awk/ {print $1}')"
    if [[ -n "$node_pids" ]]; then
      log "SIGTERM node server pids: $node_pids"
      # shellcheck disable=SC2086
      kill $node_pids 2>/dev/null || true
    else
      log "No listener found — ensure supervisor"
      bash "$ROOT/scripts/deploy.sh" ensure
      return
    fi
  fi

  local deadline started_at elapsed
  started_at="$(date +%s)"
  deadline=$((started_at + RELOAD_RECOVERY_TIMEOUT_SEC))
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    if health_local; then
      elapsed=$(($(date +%s) - started_at))
      log "Server healthy again after soft reload (${elapsed}s)"
      audit_reload "soft_reload ok ${elapsed}s"
      return 0
    fi
    sleep 1
  done
  log "WARN: soft reload did not recover — ensure (no kickstart -k)"
  audit_reload "soft_reload failed"
  bash "$ROOT/scripts/deploy.sh" ensure
  if ! health_local; then
    log "ERROR: still down — check data/logs/supervisor.log"
    return 1
  fi
}

if [[ "${GROKHACK_DEPLOY_LIBRARY_ONLY:-0}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

case "$MODE" in
  status)
    print_status
    ;;
  soft|reload)
    guard_soft_reload
    run_release_gates
    soft_reload_server
    print_status
    ;;
  pages)
    log "Deploying Cloudflare Pages (static landing mirror)"
    deploy_pages
    log "Done (game server untouched)"
    ;;
  full)
    guard_soft_reload
    run_release_gates
    soft_reload_server
    log "Deploying Cloudflare Pages (static landing mirror)"
    deploy_pages
    print_status
    log "Done. Prefer: npm run prod:status"
    ;;
  ensure)
    if health_local; then
      log "Already healthy — no-op"
      print_status
      exit 0
    fi
    if origin_local_responding; then
      log "BLOCKED: an origin is serving, but it is not the expected production release"
      log "Use the guarded soft-reload path; ensure will not replace live traffic implicitly"
      exit 2
    fi
    log "Local down — installing/kickstarting LaunchAgent"
    bash "$ROOT/scripts/install-service.sh" install
    deadline=$(($(date +%s) + RELOAD_RECOVERY_TIMEOUT_SEC))
    while [[ "$(date +%s)" -lt "$deadline" ]]; do
      health_local && break
      sleep 1
    done
    if ! health_local; then
      log "ERROR: supervisor ensure did not produce the expected production release"
      print_status
      exit 1
    fi
    print_status
    ;;
  freeze)
    touch "$RUN_DIR/NO_RESTART"
    log "Freeze ON — soft reloads blocked until: rm data/run/NO_RESTART"
    ;;
  unfreeze)
    rm -f "$RUN_DIR/NO_RESTART"
    log "Freeze OFF"
    ;;
  *)
    echo "Usage: $0 {status|soft|reload|pages|full|ensure|freeze|unfreeze}"
    echo "  status   — local + prod /api/status + processes"
    echo "  soft     — soft-reload only if no players + rate limit (FORCE=1|2 to override)"
    echo "  pages    — Cloudflare Pages only (no game restart)"
    echo "  full     — tests + pages + soft-reload (guarded)"
    echo "  ensure   — if :8080 down, install/start supervisor"
    echo "  freeze   — set NO_RESTART lock"
    echo "  unfreeze — clear NO_RESTART lock"
    exit 1
    ;;
esac
