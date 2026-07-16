#!/usr/bin/env bash
# GrokHack free local CI — canonical release evidence without GitHub Actions.
# Replaces the billing-locked hosted workflow. $0. Uses this machine only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/usr/bin:/bin:${PATH:-}"

MODE="${1:-full}" # full | quick | write-receipt
SKIP_INSTALL="${SKIP_INSTALL:-0}"
SKIP_AUDIT="${SKIP_AUDIT:-0}"
WRITE_RECEIPT="${WRITE_RECEIPT:-1}"
RECEIPT_DIR="${RECEIPT_DIR:-$ROOT/docs/proofs}"

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

require_cmd node
require_cmd npm
require_cmd git

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  die "Node >= 22 required (found $(node -v))"
fi

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
BRANCH="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo detached)"
DIRTY="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
HOST="$(hostname -s 2>/dev/null || hostname || echo local)"
RESULTS=()

run_step() {
  local name="$1"
  shift
  log "[$name] $*"
  local step_start step_end elapsed
  step_start="$(date +%s)"
  if "$@"; then
    step_end="$(date +%s)"
    elapsed=$((step_end - step_start))
    RESULTS+=("PASS|$name|${elapsed}s")
    log "[$name] PASS (${elapsed}s)"
  else
    local rc=$?
    step_end="$(date +%s)"
    elapsed=$((step_end - step_start))
    RESULTS+=("FAIL|$name|${elapsed}s|exit=$rc")
    log "[$name] FAIL (${elapsed}s, exit $rc)"
    return "$rc"
  fi
}

write_receipt() {
  [[ "$WRITE_RECEIPT" == "1" ]] || return 0
  mkdir -p "$RECEIPT_DIR"
  local stamp path status_line
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  path="$RECEIPT_DIR/${stamp}-local-ci-receipt.md"
  status_line="PASS"
  for row in "${RESULTS[@]+"${RESULTS[@]}"}"; do
    [[ "$row" == FAIL* ]] && status_line="FAIL"
  done
  {
    echo "# Local CI receipt"
    echo
    echo "- Timestamp: $STARTED_AT → $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "- Host: \`$HOST\`"
    echo "- Branch: \`$BRANCH\`"
    echo "- HEAD: \`$SHA\`"
    echo "- Dirty files: $DIRTY"
    echo "- Node: \`$(node -v)\` npm: \`$(npm -v)\`"
    echo "- Mode: \`$MODE\`"
    echo "- Result: **$status_line**"
    echo "- Runner: **local free CI** (\`npm run ci\`) — not GitHub Actions"
    echo
    echo "## Steps"
    echo
    echo "| Status | Step | Duration |"
    echo "| --- | --- | --- |"
    for row in "${RESULTS[@]+"${RESULTS[@]}"}"; do
      IFS='|' read -r st name dur extra <<<"$row"
      if [[ -n "${extra:-}" ]]; then
        echo "| $st | $name | $dur ($extra) |"
      else
        echo "| $st | $name | $dur |"
      fi
    done
    echo
    echo "## Reproduce"
    echo
    echo '```bash'
    echo "cd $ROOT"
    echo "npm run ci"
    echo '```'
    echo
    echo "## Non-claims"
    echo
    echo "- Hosted GitHub Actions is intentionally unused (billing lock / zero spend policy)."
    echo "- This receipt is local machine evidence for the exact HEAD above."
    echo "- Production deploy/soft-reload remains a separate ops step."
  } >"$path"
  log "Wrote receipt $path"
  printf '%s\n' "$path"
}

install_deps() {
  if [[ "$SKIP_INSTALL" == "1" ]]; then
    log "Skipping npm ci (SKIP_INSTALL=1)"
    return 0
  fi
  npm ci
  npm ci --prefix edge
  npm ci --prefix mcp
}

audit_deps() {
  if [[ "$SKIP_AUDIT" == "1" ]]; then
    log "Skipping npm audit (SKIP_AUDIT=1)"
    return 0
  fi
  npm audit --omit=dev --audit-level=moderate
  npm audit --omit=dev --audit-level=moderate --prefix edge
  npm audit --omit=dev --audit-level=moderate --prefix mcp
}

run_quick() {
  run_step lint npm run lint
  run_step test npm test
  run_step build npm run build
  run_step server-types npm run check:server-types
}

run_full() {
  if command -v tmux >/dev/null 2>&1; then
    run_step tmux tmux -V
  else
    log "tmux not installed; fixture suites that need it may fail"
  fi
  run_step install install_deps
  run_step audit audit_deps
  run_step lint npm run lint
  run_step test-coverage npm run test:coverage
  run_step test-shuffle npm test -- --sequence.shuffle --sequence.seed=20260710
  run_step test-property npm run test:property
  run_step test-shadow-e2e npm run test:shadow-e2e
  run_step build npm run build
  run_step server-types npm run check:server-types
  run_step edge-verify npm run edge:verify
  run_step mcp-build npm run mcp:build
}

main() {
  log "GrokHack free local CI (no GitHub Actions)"
  log "HEAD=$SHA branch=$BRANCH dirty=$DIRTY node=$(node -v)"

  case "$MODE" in
    full) run_full ;;
    quick) run_quick ;;
    write-receipt)
      WRITE_RECEIPT=1
      run_full
      ;;
    *)
      die "usage: $0 [full|quick|write-receipt]"
      ;;
  esac

  local failed=0
  for row in "${RESULTS[@]+"${RESULTS[@]}"}"; do
    [[ "$row" == FAIL* ]] && failed=1
  done

  local receipt=""
  if [[ "$WRITE_RECEIPT" == "1" ]]; then
    receipt="$(write_receipt || true)"
  fi

  if [[ "$failed" -ne 0 ]]; then
    die "local CI failed — see steps above${receipt:+ and $receipt}"
  fi
  log "Local CI PASS${receipt:+ — $receipt}"
}

main
