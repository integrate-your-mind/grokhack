#!/usr/bin/env bash
# Spawn a shellbook grok worker window WITHOUT stealing focus from the active window.
# Usage: fleet-spawn-window.sh <window-name> [role]
# Always uses: tmux new-window -d  (detached — does not change active window)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION="${FLEET_TMUX_SESSION:-grok-build}"
SOCKET_DEFAULT="${FLEET_TMUX_SOCKET:-default}"
NAME="${1:?window name required}"
ROLE="${2:-worker}"

export TMUX=

# Remember active window; restore if anything switches us
ACTIVE_BEFORE=$(tmux -L "$SOCKET_DEFAULT" display-message -t "$SESSION" -p '#{window_index}' 2>/dev/null || echo "")

if tmux -L "$SOCKET_DEFAULT" list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -qx "$NAME"; then
  echo "window already exists: $NAME (focus preserved)"
else
  # -d = do not make the new window active (critical for CEO watch window)
  tmux -L "$SOCKET_DEFAULT" new-window -d -t "${SESSION}:" -n "$NAME" -c "$ROOT"
  echo "created detached window: $NAME role=$ROLE"
fi

# Launch shellbook grok if pane is a bare shell
cmd=$(tmux -L "$SOCKET_DEFAULT" display-message -t "${SESSION}:${NAME}" -p '#{pane_current_command}' 2>/dev/null || echo "")
if [[ "$cmd" == "zsh" || "$cmd" == "bash" || "$cmd" == "sh" ]]; then
  tmux -L "$SOCKET_DEFAULT" send-keys -t "${SESSION}:${NAME}" -l "cd $ROOT && shellbook grok"
  tmux -L "$SOCKET_DEFAULT" send-keys -t "${SESSION}:${NAME}" Enter
  echo "launched shellbook grok in $NAME"
fi

# Restore focus if it drifted
ACTIVE_AFTER=$(tmux -L "$SOCKET_DEFAULT" display-message -t "$SESSION" -p '#{window_index}' 2>/dev/null || echo "")
if [[ -n "$ACTIVE_BEFORE" && -n "$ACTIVE_AFTER" && "$ACTIVE_BEFORE" != "$ACTIVE_AFTER" ]]; then
  tmux -L "$SOCKET_DEFAULT" select-window -t "${SESSION}:${ACTIVE_BEFORE}"
  echo "restored focus to window index $ACTIVE_BEFORE"
else
  echo "focus unchanged (active index=${ACTIVE_AFTER:-unknown})"
fi
