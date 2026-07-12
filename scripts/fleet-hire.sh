#!/usr/bin/env bash
# Hire a GrokHack employee agent without stealing the human's watch-window focus.
# Any fleet agent may call this.
#
# Usage:
#   export TMUX=
#   bash scripts/fleet-hire.sh <window-name> <role> '<goal>'
#
# Example:
#   bash scripts/fleet-hire.sh items-id items 'Own unidentified items/potions ID game in src/…'
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION="${FLEET_TMUX_SESSION:-grok-build}"
SOCKET_DEFAULT="${FLEET_TMUX_SOCKET:-default}"
FLEET_DIR="$ROOT/data/fleet"
WORKERS_FILE="$FLEET_DIR/workers.jsonl"
NAME="${1:?window-name required}"
ROLE="${2:?role required}"
GOAL="${3:?goal text required}"

mkdir -p "$FLEET_DIR"
export TMUX=

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

ACTIVE_BEFORE=$(tmux -L "$SOCKET_DEFAULT" display-message -t "$SESSION" -p '#{window_index}' 2>/dev/null || echo "")

# Snapshot sockets before hire
before=$(ls /tmp/tmux-501/shellbook-grok-* 2>/dev/null | xargs -n1 basename 2>/dev/null | sort || true)

# Create detached window (NEVER steals focus)
if tmux -L "$SOCKET_DEFAULT" list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -qx "$NAME"; then
  echo "[hire] window exists: $NAME"
else
  tmux -L "$SOCKET_DEFAULT" new-window -d -t "${SESSION}:" -n "$NAME" -c "$ROOT"
  echo "[hire] created detached window: $NAME"
fi

# Launch shellbook grok if needed
cmd=$(tmux -L "$SOCKET_DEFAULT" display-message -t "${SESSION}:${NAME}" -p '#{pane_current_command}' 2>/dev/null || echo "")
if [[ "$cmd" == "zsh" || "$cmd" == "bash" || "$cmd" == "sh" || -z "$cmd" ]]; then
  tmux -L "$SOCKET_DEFAULT" send-keys -t "${SESSION}:${NAME}" -l "cd $ROOT && shellbook grok"
  sleep 0.05
  tmux -L "$SOCKET_DEFAULT" send-keys -t "${SESSION}:${NAME}" Enter
  echo "[hire] launched shellbook grok"
elif [[ "$cmd" == "shellbook" ]]; then
  echo "[hire] shellbook already running in $NAME"
else
  echo "[hire] pane cmd=$cmd — attempting shellbook grok anyway"
  tmux -L "$SOCKET_DEFAULT" send-keys -t "${SESSION}:${NAME}" -l "cd $ROOT && shellbook grok"
  tmux -L "$SOCKET_DEFAULT" send-keys -t "${SESSION}:${NAME}" Enter
fi

# Wait for new socket (or map existing via process tree)
socket=""
for i in $(seq 1 45); do
  after=$(ls /tmp/tmux-501/shellbook-grok-* 2>/dev/null | xargs -n1 basename 2>/dev/null | sort || true)
  new=$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | head -1 || true)
  if [[ -n "$new" ]]; then
    socket="$new"
    break
  fi
  # Map by process tree from pane pid
  pane_pid=$(tmux -L "$SOCKET_DEFAULT" display-message -t "${SESSION}:${NAME}" -p '#{pane_pid}' 2>/dev/null || true)
  if [[ -n "$pane_pid" ]]; then
    found=$(python3 - <<PY
import subprocess, re
root = int("$pane_pid")
out = subprocess.check_output(["ps", "-ax", "-o", "pid=,ppid=,command="], text=True)
children, cmds = {}, {}
for line in out.splitlines():
    parts = line.strip().split(None, 2)
    if len(parts) < 3: continue
    pid, ppid, cmd = int(parts[0]), int(parts[1]), parts[2]
    children.setdefault(ppid, []).append(pid)
    cmds[pid] = cmd
stack, seen = [root], set()
while stack:
    p = stack.pop()
    if p in seen: continue
    seen.add(p)
    m = re.search(r"shellbook-grok-[a-f0-9]+", cmds.get(p, ""))
    if m:
        print(m.group(0)); raise SystemExit
    stack.extend(children.get(p, []))
PY
)
    if [[ -n "$found" ]]; then
      socket="$found"
      break
    fi
  fi
  sleep 1
done

if [[ -z "$socket" ]]; then
  echo "[hire] ERROR: no shellbook-grok socket for window $NAME" >&2
  # restore focus before exit
  if [[ -n "$ACTIVE_BEFORE" ]]; then
    tmux -L "$SOCKET_DEFAULT" select-window -t "${SESSION}:${ACTIVE_BEFORE}" 2>/dev/null || true
  fi
  exit 1
fi

echo "[hire] socket=$socket role=$ROLE window=$NAME"

# Wait for Grok prompt, then send goal (with hire permission clause)
FULL_GOAL="$GOAL

HIRE RIGHTS: You may create more employees when needed via: export TMUX=; bash scripts/fleet-hire.sh <window-name> <role> '<goal>'. Always uses detached windows (never steals the human's watch focus). Read data/fleet/HIRE.md and data/fleet/CEO_CHARTER.md. Stay in your ownership lanes; coordinate file conflicts."

# Poll until looks ready
for i in $(seq 1 30); do
  bottom=$(tmux -L "$socket" capture-pane -t "$socket" -p -S -12 2>/dev/null | tail -10 || true)
  if echo "$bottom" | grep -qE 'always-approve|Enter:send|Grok 4' && ! echo "$bottom" | grep -qE '\[stop\]'; then
    break
  fi
  # also accept if busy already (we'll interject)
  if echo "$bottom" | grep -qE '\[stop\]|Esc:cancel'; then
    break
  fi
  sleep 1
done

tmux -L "$socket" send-keys -t "$socket" C-u 2>/dev/null || true
sleep 0.15
tmux -L "$socket" send-keys -t "$socket" -l "$FULL_GOAL" 2>/dev/null || true
sleep 0.1
tmux -L "$socket" send-keys -t "$socket" Enter 2>/dev/null || true
echo "[hire] goal sent to $socket"

# Register worker for fleet-manager
python3 - <<PY
import json
from pathlib import Path
p = Path("$WORKERS_FILE")
row = {
  "at": "$(ts)",
  "window": "$NAME",
  "socket": "$socket",
  "role": "$ROLE",
  "goal": """$GOAL""".strip()[:2000],
  "manager": "hire",
}
# dedupe by socket: rewrite file without same socket
lines = []
if p.exists():
    for line in p.read_text().splitlines():
        if not line.strip(): continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        if o.get("socket") == row["socket"] or o.get("window") == row["window"]:
            continue
        lines.append(json.dumps(o))
lines.append(json.dumps(row))
p.write_text("\n".join(lines) + "\n")
print("[hire] registered in workers.jsonl")
PY

# Restore focus if stolen
ACTIVE_AFTER=$(tmux -L "$SOCKET_DEFAULT" display-message -t "$SESSION" -p '#{window_index}' 2>/dev/null || echo "")
if [[ -n "$ACTIVE_BEFORE" && -n "$ACTIVE_AFTER" && "$ACTIVE_BEFORE" != "$ACTIVE_AFTER" ]]; then
  tmux -L "$SOCKET_DEFAULT" select-window -t "${SESSION}:${ACTIVE_BEFORE}" 2>/dev/null || true
  echo "[hire] restored focus to window $ACTIVE_BEFORE"
else
  echo "[hire] focus ok (active=${ACTIVE_AFTER:-?})"
fi

echo "[hire] DONE window=$NAME socket=$socket role=$ROLE"
