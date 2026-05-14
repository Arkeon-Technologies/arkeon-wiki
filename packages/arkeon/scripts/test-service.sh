#!/usr/bin/env bash
# Copyright (c) 2026 Arkeon Technologies, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# Manual end-to-end smoke test for `arkeon-wiki install / uninstall`.
#
# Runs the full lifecycle (install → status → kill -9 → down → up →
# uninstall) against an isolated `--name service-smoke-test` instance,
# asserting expected state at each step. Cleans up on any failure via
# a trap. ~30s wall-clock end-to-end.
#
# Platform-aware: dispatches to launchctl on macOS, systemctl --user
# on Linux. The two supervisors have different output formats and
# call shapes, but the lifecycle semantics are the same — clean down
# stays down, kill -9 triggers Restart=on-failure / KeepAlive, etc.
#
# Not a CI test — it mutates ~/Library/LaunchAgents (Mac) /
# ~/.config/systemd/user (Linux), so the PR author runs it once on
# their machine before merging.
#
# For dev iteration of the *Linux* path FROM a Mac, use the separate
# `test/systemd-integration/run.sh` harness which spins up
# systemd-in-Docker.
#
# Usage:
#   packages/arkeon/scripts/test-service.sh
#
# Requirements:
#   - built CLI at packages/arkeon/dist/index.js
#   - on Linux: systemctl --user must be reachable (skip on Alpine, WSL1)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLI="$REPO_ROOT/packages/arkeon/dist/index.js"
NAME="service-smoke-test"
DATA_DIR="$HOME/.arkeon-wiki/$NAME"

# --- Platform detection ---

case "${OSTYPE:-}" in
  darwin*) PLATFORM=launchd ;;
  linux*)  PLATFORM=systemd ;;
  *) echo "test-service.sh: unsupported platform: $OSTYPE" >&2; exit 1 ;;
esac

# --- Platform-specific knobs + helpers ---

if [[ "$PLATFORM" == "launchd" ]]; then
  LABEL="tech.arkeon.wiki.$NAME"
  UNIT_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
  SUPERVISOR_HANDLE="gui/$UID/$LABEL"

  supervisor_pid() {
    launchctl print "$SUPERVISOR_HANDLE" 2>&1 | awk '/^\tpid = /{print $3; exit}'
  }
  supervisor_is_running() {
    launchctl print "$SUPERVISOR_HANDLE" 2>&1 | grep -qE "^\sstate = running"
  }
  supervisor_is_stopped() {
    launchctl print "$SUPERVISOR_HANDLE" 2>&1 | grep -qE "^\sstate = not running"
  }
  supervisor_unknown() {
    ! launchctl print "$SUPERVISOR_HANDLE" >/dev/null 2>&1
  }
  # ThrottleInterval=10; give kernel + launchd a small buffer.
  CRASH_WAIT=12
  # After clean exit, give launchd up to 15s — comfortably past ThrottleInterval.
  DOWN_WAIT=15
else
  UNIT_NAME="arkeon-wiki-$NAME"
  UNIT_FILE="$UNIT_NAME.service"
  UNIT_PATH="$HOME/.config/systemd/user/$UNIT_FILE"
  SUPERVISOR_HANDLE="$UNIT_FILE"

  supervisor_pid() {
    systemctl --user show "$UNIT_FILE" -p MainPID 2>/dev/null | cut -d= -f2
  }
  supervisor_is_running() {
    [[ "$(systemctl --user is-active "$UNIT_FILE" 2>/dev/null || true)" == "active" ]]
  }
  supervisor_is_stopped() {
    local state
    state="$(systemctl --user is-active "$UNIT_FILE" 2>/dev/null || true)"
    [[ "$state" == "inactive" || "$state" == "failed" ]]
  }
  supervisor_unknown() {
    local load
    load="$(systemctl --user show "$UNIT_FILE" -p LoadState 2>/dev/null | cut -d= -f2 || true)"
    [[ "$load" == "not-found" || -z "$load" ]]
  }
  # RestartSec=10; give systemd a small buffer past that.
  CRASH_WAIT=15
  DOWN_WAIT=15
fi

cleanup() {
  local exit_code=$?
  echo
  echo "== cleanup =="
  # Best-effort — none of these should fail the script.
  node "$CLI" uninstall --name "$NAME" >/dev/null 2>&1 || true
  rm -f "$UNIT_PATH"
  rm -rf "$DATA_DIR"
  if [[ $exit_code -ne 0 ]]; then
    echo "FAILED (exit $exit_code)" >&2
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

# --- Preconditions ---

[[ -f "$CLI" ]] || { echo "Built CLI not found at $CLI. Run 'npm run build' first." >&2; exit 1; }
[[ ! -e "$UNIT_PATH" ]] || { echo "Stale unit at $UNIT_PATH — manual cleanup needed before running." >&2; exit 1; }

echo "platform: $PLATFORM ($(uname -s -m))"
echo "instance: $NAME"
echo "unit:     $UNIT_PATH"

# --- 1. install ---

step "1. install --name $NAME --no-env"
INSTALL_OUT=$(node "$CLI" install --name "$NAME" --no-env 2>&1)
echo "$INSTALL_OUT"
require "install ok=true" echo "$INSTALL_OUT" | grep -q '"ok": true'
require "install running=true" echo "$INSTALL_OUT" | grep -q '"running": true'
require "unit file exists" test -f "$UNIT_PATH"
require "supervisor knows the unit" supervisor_is_running

# Install returns when the supervisor reports the service active. The
# daemon's own pidfile is written by start.ts a few hundred ms later,
# after the API binds the port. Real users hit this delay invisibly
# between commands; the harness runs back-to-back and would race.
for i in 1 2 3 4 5 6 7 8 9 10; do
  [[ -f "$DATA_DIR/arkeon.pid" ]] && break
  sleep 0.5
done
require "pidfile present after install" test -f "$DATA_DIR/arkeon.pid"

# --- 2. status (running) ---

step "2. status --name $NAME (expect state=running, service.installed=true)"
STATUS_OUT=$(node "$CLI" status --name "$NAME" 2>&1)
echo "$STATUS_OUT"
require "status state=running" echo "$STATUS_OUT" | grep -q '"state": "running"'
require "status service.installed=true" echo "$STATUS_OUT" | grep -q '"installed": true'

# --- 3. supervisor pid is alive ---

step "3. supervisor pid is alive"
SUP_PID=$(supervisor_pid)
echo "supervisor pid: $SUP_PID"
require "pid is alive" kill -0 "$SUP_PID"

# --- 4. crash recovery ---

step "4. kill -9 $SUP_PID; wait ${CRASH_WAIT}s; supervisor should restart"
kill -9 "$SUP_PID"
sleep "$CRASH_WAIT"
NEW_PID=$(supervisor_pid)
echo "new pid: $NEW_PID"
require "new pid differs from killed one" test "$NEW_PID" != "$SUP_PID"
require "new pid is alive" kill -0 "$NEW_PID"
require "supervisor reports running again" supervisor_is_running

# --- 5. down: clean exit, supervisor respects ---

step "5. down --name $NAME (clean exit; supervisor must NOT auto-restart)"
node "$CLI" down --name "$NAME" 2>&1 | tail -5
sleep "$DOWN_WAIT"
require "after down, supervisor reports stopped" supervisor_is_stopped
require "process is gone" bash -c "! kill -0 $NEW_PID 2>/dev/null"

# --- 6. up resumes via supervisor (no orphan spawn) ---

step "6. up --name $NAME (should resume via supervisor)"
UP_OUT=$(node "$CLI" up --name "$NAME" 2>&1)
echo "$UP_OUT"
require "up reports managed_by=service" echo "$UP_OUT" | grep -q '"managed_by": "service"'
UP_PID=$(echo "$UP_OUT" | awk -F': ' '/"pid":/{gsub(/[, ]/, "", $2); print $2; exit}')
SUP_PID_AFTER_UP=$(supervisor_pid)
require "up's pid matches supervisor's pid" test "$UP_PID" = "$SUP_PID_AFTER_UP"

# --- 7. uninstall ---

step "7. uninstall --name $NAME"
UNINSTALL_OUT=$(node "$CLI" uninstall --name "$NAME" 2>&1)
echo "$UNINSTALL_OUT"
require "uninstall removed=true" echo "$UNINSTALL_OUT" | grep -q '"removed": true'
require "unit file gone" bash -c "! test -e $UNIT_PATH"
require "supervisor no longer knows the unit" supervisor_unknown

# --- 8. data dir preserved (uninstall must not touch user data) ---

step "8. data dir preserved"
require "data dir still exists" test -d "$DATA_DIR"
require "database file still exists" test -f "$DATA_DIR/data/arke.db"

echo
echo "== all assertions passed ($PLATFORM) =="
