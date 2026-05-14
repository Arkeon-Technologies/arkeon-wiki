#!/usr/bin/env bash
# Copyright (c) 2026 Arkeon Technologies, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# End-to-end Linux systemd integration test for arkeon-wiki install.
#
# Spins up a systemd-in-Docker container, mounts the built CLI in,
# runs the full lifecycle (install → status → kill → restart →
# down → up → uninstall) inside, asserts state at each step. ~60s
# end-to-end on Apple Silicon. Suitable for both dev iteration and CI.
#
# Requirements:
#   - Docker daemon running
#   - Built CLI at packages/arkeon/dist/index.js (run `npm run build` first)
#
# Usage:
#   packages/arkeon/test/systemd-integration/run.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
IMAGE_TAG="arkeon-wiki-systemd-test:local"
CONTAINER_NAME="arkeon-wiki-systemd-test"
INSTANCE_NAME="systemd-smoke"
UNIT_FILE="arkeon-wiki-${INSTANCE_NAME}.service"

# `su - arkeon -c` clears the environment and re-sources only login
# files, so Dockerfile ENV declarations don't propagate. Hardcode the
# in-container CLI path here and expand it in the outer shell before
# `in_container` forwards the string to the inner shell.
ARKEON_CLI=/opt/arkeon-wiki/packages/arkeon/dist/index.js

if [[ ! -f "$PKG_DIR/dist/index.js" ]]; then
  echo "Built CLI not found at $PKG_DIR/dist/index.js" >&2
  echo "Run 'npm run build -w packages/arkeon' first." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running." >&2
  exit 1
fi

cleanup() {
  local exit_code=$?
  echo
  echo "== cleanup =="
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
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

# Run a command inside the container as the arkeon user, through a
# full login shell. `docker exec -u arkeon` skips pam_systemd, which
# means XDG_RUNTIME_DIR isn't set and `systemctl --user` errors with
# "Failed to connect to bus: No medium found". `su - arkeon -c` goes
# through pam, which establishes the user-bus correctly.
in_container() {
  docker exec -i "$CONTAINER_NAME" su - arkeon -c "$*"
}

# Wait until PID-1 systemd is "running" (system-level) and then
# enable linger for the arkeon user so user-systemd comes up. The
# probe uses `su -` so pam_systemd sets up XDG_RUNTIME_DIR — without
# that, systemctl --user can't reach the user-bus.
wait_for_system_systemd() {
  for i in $(seq 1 30); do
    if docker exec "$CONTAINER_NAME" systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded'; then
      return 0
    fi
    sleep 1
  done
  echo "PID-1 systemd never came up inside the container" >&2
  return 1
}

wait_for_user_systemd() {
  for i in $(seq 1 30); do
    if docker exec "$CONTAINER_NAME" su - arkeon -c "systemctl --user is-system-running 2>/dev/null | grep -qE 'running|degraded'"; then
      return 0
    fi
    sleep 1
  done
  echo "user-systemd never came up inside the container" >&2
  return 1
}

# --- 1. build image ---

step "1. build systemd-in-docker test image"
# jrei/systemd-debian is amd64-only; pin the platform so the build
# succeeds on Apple Silicon under qemu emulation. Build context is
# the repo root so we can COPY package.json + lockfile for the
# in-image `npm ci` (which compiles better-sqlite3 et al. for
# linux/amd64; the host's node_modules is the wrong arch).
docker build --platform linux/amd64 -t "$IMAGE_TAG" -f "$SCRIPT_DIR/Dockerfile" "$REPO_ROOT" >/tmp/arkeon-systemd-build.log 2>&1 || {
  tail -30 /tmp/arkeon-systemd-build.log >&2
  exit 1
}
echo "image built: $IMAGE_TAG"

# --- 2. start container ---

step "2. start container with mounted CLI"
# Mount the entire workspace at /opt/arkeon-wiki so dist/index.js +
# bundled schema + agent templates all resolve via their relative paths.
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
# cgroupns=host + cgroup bind mount are required for systemd-as-PID-1
# to initialize cleanly under cgroup v2 (which Docker Desktop on Mac
# uses). Without them the container exits 255 immediately. The
# tmpfs mounts are jrei/systemd-debian's documented requirements.
#
# Only the dist/ tree is mounted from host — node_modules stays in
# the image (built for linux/amd64). schema/ and agent-templates/
# sit inside dist after `npm run build` runs `bundle-schema` +
# `bundle-agent-templates`, so they ride along automatically.
docker run -d \
  --platform linux/amd64 \
  --name "$CONTAINER_NAME" \
  --privileged \
  --cgroupns=host \
  --tmpfs /tmp \
  --tmpfs /run \
  --tmpfs /run/lock \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v "$PKG_DIR/dist:/opt/arkeon-wiki/packages/arkeon/dist:ro" \
  "$IMAGE_TAG" >/dev/null

echo "waiting for PID-1 systemd..."
wait_for_system_systemd

# Enable linger now that systemd is alive — this is what the install
# command would also do (best-effort) at install time, but doing it
# here first means user-systemd is up by the time we exercise the CLI.
docker exec "$CONTAINER_NAME" loginctl enable-linger arkeon

echo "waiting for user-systemd..."
wait_for_user_systemd
echo "user-systemd is up"

# --- 3. install ---

step "3. arkeon-wiki install --name $INSTANCE_NAME --no-env"
INSTALL_OUT=$(in_container "node $ARKEON_CLI install --name $INSTANCE_NAME --no-env")
echo "$INSTALL_OUT"
echo "$INSTALL_OUT" | grep -q '"ok": true' || { echo "install did not return ok=true"; exit 1; }
echo "$INSTALL_OUT" | grep -q '"running": true' || { echo "install did not return running=true"; exit 1; }
echo "$INSTALL_OUT" | grep -q '"platform": "systemd"' || { echo "install did not target systemd"; exit 1; }

# --- 4. unit file on disk ---

step "4. unit file present at ~/.config/systemd/user/$UNIT_FILE"
in_container "test -f ~/.config/systemd/user/$UNIT_FILE" || { echo "unit file missing"; exit 1; }
in_container "cat ~/.config/systemd/user/$UNIT_FILE | head -10"

# --- 5. systemctl agrees ---

step "5. systemctl --user is-active reports active"
ACTIVE_OUT=$(in_container "systemctl --user is-active $UNIT_FILE")
echo "is-active: $ACTIVE_OUT"
[[ "$ACTIVE_OUT" == "active" ]] || { echo "expected active, got $ACTIVE_OUT"; exit 1; }

# --- 6. status (CLI) ---

step "6. arkeon-wiki status --name $INSTANCE_NAME"
# Tight race: install returns when systemd says active, but the
# daemon's own pidfile lands a few hundred ms later. Poll.
for i in 1 2 3 4 5 6 7 8 9 10; do
  if in_container "test -f ~/.arkeon-wiki/$INSTANCE_NAME/arkeon.pid"; then break; fi
  sleep 0.5
done
STATUS_OUT=$(in_container "node $ARKEON_CLI status --name $INSTANCE_NAME")
echo "$STATUS_OUT"
echo "$STATUS_OUT" | grep -q '"state": "running"' || { echo "status did not report running"; exit 1; }
echo "$STATUS_OUT" | grep -q '"installed": true' || { echo "status did not report service installed"; exit 1; }

# --- 7. crash recovery ---

step "7. kill -9 main pid; wait for systemd Restart=on-failure"
PID=$(in_container "systemctl --user show $UNIT_FILE -p MainPID | cut -d= -f2")
echo "killing pid $PID"
in_container "kill -9 $PID" || true
sleep 12   # RestartSec=10
NEW_PID=$(in_container "systemctl --user show $UNIT_FILE -p MainPID | cut -d= -f2")
echo "new pid: $NEW_PID"
[[ "$NEW_PID" != "$PID" && "$NEW_PID" != "0" ]] || { echo "supervisor did not restart"; exit 1; }
NEW_ACTIVE=$(in_container "systemctl --user is-active $UNIT_FILE")
[[ "$NEW_ACTIVE" == "active" ]] || { echo "service not active after restart"; exit 1; }

# --- 8. down: clean exit, systemd respects ---

step "8. down → wait → systemd does NOT auto-restart"
in_container "node $ARKEON_CLI down --name $INSTANCE_NAME" | tail -5
sleep 15
DOWN_STATE=$(in_container "systemctl --user is-active $UNIT_FILE || true")
echo "after down: $DOWN_STATE"
[[ "$DOWN_STATE" == "inactive" ]] || { echo "expected inactive after down, got $DOWN_STATE"; exit 1; }

# --- 9. up resumes via supervisor ---

step "9. up --name $INSTANCE_NAME — should systemctl start, not spawn orphan"
UP_OUT=$(in_container "node $ARKEON_CLI up --name $INSTANCE_NAME")
echo "$UP_OUT"
echo "$UP_OUT" | grep -q '"managed_by": "service"' || { echo "up did not report managed_by=service"; exit 1; }
UP_PID=$(in_container "systemctl --user show $UNIT_FILE -p MainPID | cut -d= -f2")
[[ "$UP_PID" != "0" ]] || { echo "no pid after up"; exit 1; }

# --- 10. uninstall ---

step "10. uninstall --name $INSTANCE_NAME"
UNINSTALL_OUT=$(in_container "node $ARKEON_CLI uninstall --name $INSTANCE_NAME")
echo "$UNINSTALL_OUT"
echo "$UNINSTALL_OUT" | grep -q '"removed": true' || { echo "uninstall did not return removed=true"; exit 1; }
in_container "test ! -f ~/.config/systemd/user/$UNIT_FILE" || { echo "unit file still present after uninstall"; exit 1; }
LOAD_AFTER=$(in_container "systemctl --user show $UNIT_FILE -p LoadState | cut -d= -f2")
[[ "$LOAD_AFTER" == "not-found" ]] || { echo "expected LoadState=not-found, got $LOAD_AFTER"; exit 1; }

# --- 11. data dir preserved ---

step "11. data dir survives uninstall"
in_container "test -d ~/.arkeon-wiki/$INSTANCE_NAME" || { echo "data dir removed by uninstall"; exit 1; }
in_container "test -f ~/.arkeon-wiki/$INSTANCE_NAME/data/arke.db" || { echo "database removed by uninstall"; exit 1; }

echo
echo "== all 11 systemd-integration assertions passed =="
