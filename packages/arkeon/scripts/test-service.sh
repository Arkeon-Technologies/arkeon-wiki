#!/usr/bin/env bash
# Copyright (c) 2026 Arkeon Technologies, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# Manual end-to-end smoke test for `arkeon-wiki install / uninstall`.
#
# Runs the full lifecycle (install → status → up → down → kickstart
# resumes → uninstall) against an isolated `--name service-smoke-test`
# instance, asserting expected state at each step. Cleans up on any
# failure via a trap. ~30s wall-clock end-to-end.
#
# Not a CI test — it mutates ~/Library/LaunchAgents (Mac) /
# ~/.config/systemd/user (Linux), so the PR author runs it once on
# their machine before merging.
#
# Usage:
#   packages/arkeon/scripts/test-service.sh
#
# Requirements:
#   - built CLI at packages/arkeon/dist/index.js
#   - macOS (launchd) for now; Linux (systemd) lands with PR2

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLI="$REPO_ROOT/packages/arkeon/dist/index.js"
NAME="service-smoke-test"
LABEL="tech.arkeon.wiki.$NAME"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DATA_DIR="$HOME/.arkeon-wiki/$NAME"

# Per nameToPortSlot() in local-runtime.ts: 8000 + (sha256(name) bytes
# 0-1 mod 999) + 1. We don't recompute here — discover at runtime.
PORT=""

cleanup() {
  local exit_code=$?
  echo
  echo "== cleanup =="
  # Best-effort — none of these should fail the script.
  node "$CLI" uninstall --name "$NAME" >/dev/null 2>&1 || true
  rm -f "$PLIST"
  rm -rf "$DATA_DIR"
  if [[ $exit_code -ne 0 ]]; then
    echo "FAILED at line $LINENO (exit $exit_code)" >&2
  else
    echo "OK"
  fi
  exit $exit_code
}
trap cleanup EXIT

step() {
  echo
  echo "== $* =="
}

require() {
  local label="$1"; shift
  if ! "$@"; then
    echo "ASSERTION FAILED: $label" >&2
    exit 1
  fi
}

# Resolve PORT by parsing the running supervisor's args after install.
discover_port() {
  PORT=$(curl -sf "http://localhost:0/health" >/dev/null 2>&1; \
    for p in $(seq 8001 8999); do
      if curl -sf "http://localhost:$p/health" 2>/dev/null | grep -q "ok"; then
        # Confirm it's *our* instance, not the user's other daemon
        if launchctl print "gui/$UID/$LABEL" 2>/dev/null | grep -q "$NAME"; then
          echo "$p"; return 0
        fi
      fi
    done; echo "")
}

# --- Preconditions ---

[[ -f "$CLI" ]] || { echo "Built CLI not found at $CLI. Run 'npm run build' first." >&2; exit 1; }
[[ "$OSTYPE" == "darwin"* ]] || { echo "test-service.sh: only macOS supported in this build (Linux arrives in PR2)." >&2; exit 1; }

[[ ! -e "$PLIST" ]] || { echo "Stale plist at $PLIST — manual cleanup needed before running." >&2; exit 1; }

# --- 1. install ---

step "1. install --name $NAME --no-env"
INSTALL_OUT=$(node "$CLI" install --name "$NAME" --no-env 2>&1)
echo "$INSTALL_OUT"
require "install ok=true" echo "$INSTALL_OUT" | grep -q '"ok": true'
require "install running=true" echo "$INSTALL_OUT" | grep -q '"running": true'
require "plist exists" test -f "$PLIST"
require "launchctl knows label" launchctl print "gui/$UID/$LABEL" 2>/dev/null

# --- 2. status (running) ---

step "2. status --name $NAME (expect state=running, service.installed=true)"
STATUS_OUT=$(node "$CLI" status --name "$NAME" 2>&1)
echo "$STATUS_OUT"
require "status state=running" echo "$STATUS_OUT" | grep -q '"state": "running"'
require "status service.installed=true" echo "$STATUS_OUT" | grep -q '"installed": true'

# --- 3. /health via discovered port ---

step "3. /health probe"
PID_FROM_LAUNCHD=$(launchctl print "gui/$UID/$LABEL" 2>&1 | awk '/^\tpid = /{print $3; exit}')
echo "supervisor pid: $PID_FROM_LAUNCHD"
require "pid is alive" kill -0 "$PID_FROM_LAUNCHD"

# --- 4. crash recovery ---

step "4. kill -9 $PID_FROM_LAUNCHD; wait 12s; supervisor should restart"
kill -9 "$PID_FROM_LAUNCHD"
sleep 12  # ThrottleInterval is 10s
NEW_PID=$(launchctl print "gui/$UID/$LABEL" 2>&1 | awk '/^\tpid = /{print $3; exit}')
echo "new pid: $NEW_PID"
require "new pid differs from killed one" test "$NEW_PID" != "$PID_FROM_LAUNCHD"
require "new pid is alive" kill -0 "$NEW_PID"
require "supervisor reports running" launchctl print "gui/$UID/$LABEL" 2>&1 | grep -E "^\sstate = running"

# --- 5. down: clean exit, supervisor respects ---

step "5. down --name $NAME (clean exit; supervisor must NOT auto-restart)"
node "$CLI" down --name "$NAME" 2>&1 | tail -5
sleep 15  # well past ThrottleInterval
require "after down, NOT running" \
  bash -c 'launchctl print "gui/$UID/'"$LABEL"'" 2>&1 | grep -qE "^\\sstate = not running"'
require "process is gone" bash -c "! kill -0 $NEW_PID 2>/dev/null"

# --- 6. up resumes via supervisor (no orphan spawn) ---

step "6. up --name $NAME (should kickstart via supervisor)"
UP_OUT=$(node "$CLI" up --name "$NAME" 2>&1)
echo "$UP_OUT"
require "up reports managed_by=service" echo "$UP_OUT" | grep -q '"managed_by": "service"'
UP_PID=$(echo "$UP_OUT" | awk -F': ' '/"pid":/{gsub(/[, ]/, "", $2); print $2; exit}')
LAUNCHCTL_PID=$(launchctl print "gui/$UID/$LABEL" 2>&1 | awk '/^\tpid = /{print $3; exit}')
require "up's pid matches supervisor's pid" test "$UP_PID" = "$LAUNCHCTL_PID"

# --- 7. uninstall ---

step "7. uninstall --name $NAME"
UNINSTALL_OUT=$(node "$CLI" uninstall --name "$NAME" 2>&1)
echo "$UNINSTALL_OUT"
require "uninstall removed=true" echo "$UNINSTALL_OUT" | grep -q '"removed": true'
require "plist gone" bash -c "! test -e $PLIST"
require "launchctl no longer knows label" \
  bash -c '! launchctl print "gui/$UID/'"$LABEL"'" >/dev/null 2>&1'

# --- 8. data dir preserved (uninstall must not touch user data) ---

step "8. data dir preserved"
require "data dir still exists" test -d "$DATA_DIR"
require "database file still exists" test -f "$DATA_DIR/data/arke.db"

echo
echo "== all assertions passed =="
