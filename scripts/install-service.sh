#!/usr/bin/env bash
# Install GrokHack as a macOS LaunchAgent (survives reboot, auto-restart).
# Usage: npm run prod:install | npm run prod:uninstall | npm run prod:status
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.mondello.grokhack"
PLIST_SRC="$ROOT/deploy/launchd/com.mondello.grokhack.plist"
PLIST_DST="$HOME/Library/LaunchAgents/${LABEL}.plist"
CMD="${1:-install}"

mkdir -p "$ROOT/data/logs" "$ROOT/data/run" "$HOME/Library/LaunchAgents"
chmod +x "$ROOT/scripts/grokhack-supervisor.sh" "$ROOT/scripts/run-prod.sh" "$ROOT/scripts/deploy.sh"

render_plist() {
  sed "s|__GROKHACK_ROOT__|$ROOT|g" "$PLIST_SRC" > "$PLIST_DST"
}

bootout() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || \
    launchctl unload "$PLIST_DST" 2>/dev/null || true
}

healthy() {
  local health
  health="$(curl -sf --max-time 5 "http://127.0.0.1:8080/health?format=json" 2>/dev/null || true)"
  [[ "$health" == *'"ok":true'* && "$health" == *'"ready":true'* && "$health" == *'"productionSafe":true'* ]]
}

origin_responding() {
  local health
  health="$(curl -sf --max-time 5 "http://127.0.0.1:8080/health?format=json" 2>/dev/null || true)"
  [[ "$health" == *'"ok":true'* ]]
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

supervisor_alive() {
  pgrep -f "grokhack-supervisor.sh" >/dev/null 2>&1
}

case "$CMD" in
  install)
    echo "Installing LaunchAgent → $PLIST_DST"
    render_plist

    if healthy && supervisor_alive; then
      # Already good — do not bootout/kickstart -k (that thrash-kills :8080).
      echo "✓ Already healthy with live supervisor — plist refreshed only (no restart)"
      echo "  Logs: $ROOT/data/logs/"
      echo "  Status: npm run prod:status"
      echo "  Soft reload: bash scripts/deploy.sh soft"
      exit 0
    fi

    if healthy && ! supervisor_alive; then
      echo "Healthy :8080 but no supervisor — starting supervisor without free_port kill"
      bootout
      launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || launchctl load "$PLIST_DST"
      launchctl enable "gui/$(id -u)/$LABEL" 2>/dev/null || true
      launchctl kickstart "gui/$(id -u)/$LABEL" 2>/dev/null || true
      echo "✓ Supervisor started (adopt path should keep :8080)"
      exit 0
    fi

    if origin_responding; then
      echo "BLOCKED: :8080 is serving an older/unready release; refusing implicit replacement"
      echo "Use bash scripts/deploy.sh soft so player and reload guards remain authoritative"
      exit 2
    fi

    bootout
    launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
    launchctl enable "gui/$(id -u)/$LABEL"
    launchctl kickstart -k "gui/$(id -u)/$LABEL"
    echo "✓ GrokHack service installed and started"
    echo "  Logs: $ROOT/data/logs/"
    echo "  Status: npm run prod:status"
    ;;
  uninstall)
    echo "Removing LaunchAgent…"
    bootout
    rm -f "$PLIST_DST"
    pkill -f "grokhack-supervisor.sh" 2>/dev/null || true
    pkill -f "tsx server/index.ts" 2>/dev/null || true
    pkill -f "cloudflared tunnel --config cloudflare/grokhack-tunnel.yml" 2>/dev/null || true
    pkill -f "scripts/agent-bot.mjs" 2>/dev/null || true
    lsof -tiTCP:8080 -sTCP:LISTEN 2>/dev/null | xargs kill -9 2>/dev/null || true
    rm -f "$ROOT/data/run/"*.pid
    echo "✓ Uninstalled"
    ;;
  status)
    echo "=== launchd ==="
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | head -25 || echo "Not loaded"
    echo ""
    echo "=== health ==="
    echo -n "local:  "
    curl -sf --max-time 5 "http://127.0.0.1:8080/health?format=json" && echo "" || echo "DOWN"
    echo -n "prod:   "
    curl -sf --max-time 8 "https://grokhack.mondello.dev/health?format=json" && echo "" || echo "DOWN"
    echo ""
    echo "=== processes ==="
    safe_process_list
    echo ""
    echo "=== pid files ==="
    shopt -s nullglob
    for f in "$ROOT/data/run/"*.pid; do
      pid="$(cat "$f" 2>/dev/null || echo '?')"
      if [[ -n "$pid" && "$pid" != "0" && "$pid" != "?" ]] && kill -0 "$pid" 2>/dev/null; then
        echo "  $(basename "$f"): $pid (alive)"
      else
        echo "  $(basename "$f"): $pid (stale/dead)"
      fi
    done
    echo ""
    echo "=== recent supervisor log ==="
    tail -8 "$ROOT/data/logs/supervisor.log" 2>/dev/null || echo "no log yet"
    ;;
  reload|soft)
    exec bash "$ROOT/scripts/deploy.sh" soft
    ;;
  *)
    echo "Usage: $0 {install|uninstall|status|reload}"
    exit 1
    ;;
esac
