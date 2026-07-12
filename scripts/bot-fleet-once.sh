#!/usr/bin/env bash
# One-shot ensure: start fleet if down. Argv stays short so thrashing pkill -f
# patterns that match long shells don't kill this helper.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec bash "$ROOT/scripts/bot-fleet-supervisor.sh" "${1:-ensure}"
