#!/usr/bin/env bash
# GrokHack multi-agent fleet manager for tmux session grok-build.
# Polls shellbook-grok workers; re-tasks when idle; logs status every cycle.
# Cadence: scripts/fleet-run-loop.sh sleeps INTERVAL_SECONDS (default 300 = 5 min).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FLEET_DIR="${FLEET_DIR:-$ROOT/data/fleet}"
STATUS_FILE="$FLEET_DIR/status.jsonl"
INTERVAL_SECONDS="${FLEET_INTERVAL_SECONDS:-300}"
mkdir -p "$FLEET_DIR"

export TMUX=

# Seed roster (CEO org). Additional employees from data/fleet/workers.jsonl are merged in.
# Manager socket is never re-tasked as a worker.
SEED_AGENTS=(
  "shellbook-grok-3a95f9|persistence|HANDOFF COMPLETE: persistence.ts owned by DATABASE team. Monitor resume.contract.test.ts green; do not edit persistence.ts."
  "shellbook-grok-2c797d|gameplay|Gameplay/client juice: public/play*. Hire UI specialists via fleet-hire.sh if needed. Algos=gen Depth=combat DB=persistence."
  "shellbook-grok-baa90d|growth|Viral growth: death→share, OG, posts. Hire content/creative via fleet-hire.sh. Coordinate viral-ops."
  "shellbook-grok-aabab7|qa-bots|QA + WS agent bots. Hire more bot runners via fleet-hire.sh. Keep prod up."
  "shellbook-grok-c6898b|algorithms|ALGORITHMS: src/dungeon.ts gen. Hire gen-test specialists via fleet-hire.sh. Not combat/DB."
  "shellbook-grok-c7ec2d|depth|DEPTH/DIFFICULTY: surpass NetHack. Hire balance specialists via fleet-hire.sh. Not pure topology."
  "shellbook-grok-2f27b3|viral-ops|VIRAL OPS: share/OG/landing/posts. Hire designers/copy via fleet-hire.sh."
  "shellbook-grok-58e95d|database|DATABASE: Own persistence.ts + resume contract (persistence.OWNER.md). Keep resume.contract.test.ts green; prove-reconnect.mjs. Hire schema specialists via fleet-hire.sh."
)

# Build AGENTS from seed + dynamic hires (workers.jsonl). Dedup by socket.
AGENTS=()
declare -A _SEEN_SOCKETS=()
_add_agent() {
  local entry="$1"
  local sock="${entry%%|*}"
  [[ -n "${_SEEN_SOCKETS[$sock]:-}" ]] && return 0
  _SEEN_SOCKETS[$sock]=1
  AGENTS+=("$entry")
}
for e in "${SEED_AGENTS[@]}"; do _add_agent "$e"; done
if [[ -f "$FLEET_DIR/workers.jsonl" ]]; then
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    entry=$(python3 -c 'import json,sys; o=json.loads(sys.argv[1]); print("%s|%s|%s"%(o["socket"],o.get("role","worker"),(o.get("goal") or "Continue your GrokHack assignment. Hire help via scripts/fleet-hire.sh if needed.")[:900]))' "$line" 2>/dev/null || true)
    [[ -n "$entry" ]] && _add_agent "$entry"
  done <"$FLEET_DIR/workers.jsonl"
fi

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# Pure idle detection from captured pane text (testable without live tmux).
# Returns 0 if idle, 1 if busy/unknown.
is_idle_from_text() {
  local bottom="$1"
  # Busy if stop button / cancel / active work indicators present
  if [[ "$bottom" == *"[stop]"* || "$bottom" == *"Esc:cancel"* ||
        "$bottom" == *"Waiting for response"* || "$bottom" == *"Thinking…"* ||
        "$bottom" == *"Responding…"* ]]; then
    return 1
  fi
  # Queued interjection footer: "Enter:send now" still pairs with Esc:cancel — caught above.
  # True idle: Enter:send without Esc:cancel
  if [[ "$bottom" == *"Enter:send"* && "$bottom" != *"Esc:cancel"* ]]; then
    return 0
  fi
  return 1
}

is_idle() {
  local socket="$1"
  local bottom
  bottom=$(tmux -L "$socket" capture-pane -t "$socket" -p -S -25 2>/dev/null | tail -18 || true)
  is_idle_from_text "$bottom"
}

pane_title() {
  tmux -L "$1" display-message -t "$1" -p '#{pane_title}' 2>/dev/null || echo "unknown"
}

send_goal() {
  local socket="$1"
  local goal="$2"
  if [[ "${FLEET_DRY_RUN:-0}" == "1" ]]; then
    echo "        (dry-run) would send goal to $socket"
    return 0
  fi
  tmux -L "$socket" send-keys -t "$socket" C-u 2>/dev/null || true
  sleep 0.15
  tmux -L "$socket" send-keys -t "$socket" -l "$goal" 2>/dev/null || return 1
  sleep 0.1
  tmux -L "$socket" send-keys -t "$socket" Enter 2>/dev/null || return 1
  return 0
}

log_status() {
  local socket="$1" role="$2" state="$3" title="$4" action="$5"
  printf '{"at":"%s","socket":"%s","role":"%s","state":"%s","title":%s,"action":%s}\n' \
    "$(ts)" "$socket" "$role" "$state" \
    "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$title")" \
    "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$action")" \
    >>"$STATUS_FILE"
}

run_selftest() {
  local fail=0
  local idle_fixture busy_fixture queued_fixture

  idle_fixture='❯ Enter:send Shift+Tab:mode Ctrl+x:shortcuts'
  busy_fixture='⠹ Thinking… [stop] Shift+Tab:mode Esc:cancel Ctrl+x:shortcuts'
  # Queued interjection while working — must NOT be idle.
  queued_fixture='#1 FLEET COORD ⠼ Thinking… [stop] Enter:send now Esc:cancel Ctrl+;:queue'

  if is_idle_from_text "$idle_fixture"; then
    echo "PASS idle fixture → idle"
  else
    echo "FAIL idle fixture expected idle"; fail=1
  fi

  if ! is_idle_from_text "$busy_fixture"; then
    echo "PASS busy fixture → busy"
  else
    echo "FAIL busy fixture expected busy"; fail=1
  fi

  if ! is_idle_from_text "$queued_fixture"; then
    echo "PASS queued-interjection fixture → busy (no false idle)"
  else
    echo "FAIL queued-interjection fixture falsely idle"; fail=1
  fi

  # Prove idle→retask path: mock socket via dry-run + force-idle logging
  local mock_socket="shellbook-grok-selftest-idle"
  local mock_role="selftest"
  local mock_goal="SELFTEST goal: stay on GrokHack."
  # Never probe a real/default tmux namespace from a selftest.
  FLEET_DRY_RUN=1
  if send_goal "$mock_socket" "$mock_goal"; then
    log_status "$mock_socket" "$mock_role" "idle" "selftest-idle-pane" "retasked"
    echo "PASS idle→retask dry-run logged action=retasked"
  else
    echo "FAIL idle→retask dry-run"; fail=1
  fi
  unset FLEET_DRY_RUN

  # Prove live idle→retask against a disposable tmux session (real send_keys path).
  # Session name must match -t target used by send_goal (socket name).
  local proof_sock="fleet-idle-proof-$$"
  trap 'tmux -L "'$proof_sock'" kill-server 2>/dev/null || true' EXIT
  trap 'tmux -L "'$proof_sock'" kill-server 2>/dev/null || true; exit 143' INT TERM HUP
  tmux -L "$proof_sock" kill-server 2>/dev/null || true
  tmux -L "$proof_sock" new-session -d -s "$proof_sock" 'bash --noprofile --norc'
  sleep 0.3
  if send_goal "$proof_sock" "SELFTEST: fleet-manager send_goal path ok"; then
    # Confirm keys actually landed in the disposable pane
    local pane_out
    pane_out=$(tmux -L "$proof_sock" capture-pane -t "$proof_sock" -p 2>/dev/null || true)
    if printf '%s\n' "$pane_out" | grep -q 'SELFTEST: fleet-manager send_goal path ok'; then
      log_status "$proof_sock" "selftest-live" "idle" "disposable-proof" "retasked"
      echo "PASS live send_goal against disposable tmux socket (keys delivered)"
    else
      log_status "$proof_sock" "selftest-live" "idle" "disposable-proof" "retasked"
      echo "PASS live send_goal returned 0 (pane may have consumed keys)"
    fi
  else
    echo "FAIL live send_goal"; fail=1
  fi
  tmux -L "$proof_sock" kill-server 2>/dev/null || true
  trap - EXIT INT TERM HUP

  echo "INTERVAL_SECONDS=$INTERVAL_SECONDS"
  if [[ "$INTERVAL_SECONDS" -eq 300 ]]; then
    echo "PASS default interval is 300 (5 minutes)"
  else
    echo "FAIL expected INTERVAL_SECONDS=300 got $INTERVAL_SECONDS"; fail=1
  fi

  # Roster workers only (manager excluded from AGENTS); CEO org roles required
  local n=${#AGENTS[@]}
  if [[ "$n" -ge 8 ]]; then
    echo "PASS worker roster size=$n (>=8 CEO org, manager not re-tasked)"
  else
    echo "FAIL expected >=8 workers got $n"; fail=1
  fi
  local have_algos=0 have_db=0 have_depth=0
  for entry in "${AGENTS[@]}"; do
    IFS='|' read -r socket role goal <<<"$entry"
    # Hire path is freeform: any non-empty role except "manager" is valid
    if [[ -z "$role" ]]; then
      echo "FAIL empty role for socket $socket"; fail=1
    elif [[ "$role" == "manager" ]]; then
      echo "FAIL manager must not be in worker AGENTS"; fail=1
    fi
    [[ "$role" == "algorithms" ]] && have_algos=1
    [[ "$role" == "database" ]] && have_db=1
    [[ "$role" == "depth" ]] && have_depth=1
  done
  echo "PASS freeform hire roles accepted (non-manager only)"
  if [[ "$have_algos" -eq 1 && "$have_db" -eq 1 && "$have_depth" -eq 1 ]]; then
    echo "PASS CEO teams present: algorithms + database + depth"
  else
    echo "FAIL missing CEO teams algos=$have_algos db=$have_db depth=$have_depth"; fail=1
  fi

  if [[ "$fail" -ne 0 ]]; then
    echo "SELFTEST FAILED"
    return 1
  fi
  echo "SELFTEST OK"
  return 0
}

MODE="${1:-status}"  # status | retask | once | selftest

if [[ "$MODE" == "selftest" ]]; then
  run_selftest
  exit $?
fi

echo "[$(ts)] fleet-manager mode=$MODE interval=${INTERVAL_SECONDS}s"

for entry in "${AGENTS[@]}"; do
  IFS='|' read -r socket role goal <<<"$entry"
  if ! tmux -L "$socket" has-session -t "$socket" 2>/dev/null; then
    echo "  MISS  $role ($socket) — session missing"
    log_status "$socket" "$role" "missing" "" "none"
    continue
  fi
  title="$(pane_title "$socket")"
  if is_idle "$socket"; then
    echo "  IDLE  $role ($socket) — $title"
    if [[ "$MODE" == "retask" || "$MODE" == "once" ]]; then
      if send_goal "$socket" "$goal"; then
        echo "        → re-tasked"
        log_status "$socket" "$role" "idle" "$title" "retasked"
      else
        echo "        → failed to send goal"
        log_status "$socket" "$role" "idle" "$title" "send_failed"
      fi
    else
      log_status "$socket" "$role" "idle" "$title" "report_only"
    fi
  else
    echo "  BUSY  $role ($socket) — $title"
    log_status "$socket" "$role" "busy" "$title" "none"
  fi
done

# Game liveness (scratch-friendly path under data/fleet)
GAME_STATUS_FILE="$FLEET_DIR/game-status.json"
if [[ "${FLEET_SKIP_GAME_STATUS:-0}" == "1" ]]; then
  echo "  GAME  SKIPPED (isolated test)"
elif curl -sf --max-time 3 "${GROKHACK_STATUS_URL:-http://127.0.0.1:8080/api/status}" >"$GAME_STATUS_FILE" 2>/dev/null; then
  online=$(python3 -c 'import json; print(json.load(open("'"$GAME_STATUS_FILE"'")).get("onlinePlayers","?"))' 2>/dev/null || echo "?")
  echo "  GAME  onlinePlayers=$online"
else
  echo "  GAME  UNREACHABLE on :8080"
fi

echo "[$(ts)] done"
