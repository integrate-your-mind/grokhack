#!/usr/bin/env bash
# Foreground production — delegates to supervisor (server + tunnel + health checks).
exec "$(dirname "$0")/grokhack-supervisor.sh"