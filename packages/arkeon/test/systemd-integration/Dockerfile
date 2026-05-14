# Copyright (c) 2026 Arkeon Technologies, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# systemd-in-Docker image for testing `arkeon-wiki install` end-to-end
# against a real systemd --user instance, from a Mac dev machine.
#
# Based on jrei/systemd-debian — they handle the systemd-as-PID1
# plumbing (tmpfs mounts, cgroup setup) that's needed for `systemctl`
# to actually work inside a container. Plain debian:bookworm won't do
# this; you need an image that ships with the systemd shim.
#
# The container creates a non-root `arkeon` user with a real $HOME,
# installs node + npm, and mounts the built CLI at /opt/arkeon-wiki.
# `test-systemd.sh` runs the lifecycle from inside via `docker exec`.

# jrei/systemd-debian doesn't ship an arm64 manifest. On Apple Silicon
# Macs, callers must pass `--platform linux/amd64` (the integration
# test script does this); the container then runs under qemu emulation
# at ~20% overhead — fine for a one-off test cycle.
FROM jrei/systemd-debian:12

# Node 20 LTS — matches the package.json engines target. The Debian
# repo's node is 18, which works but we want parity with prod (Node
# 20+ is what arkeon-wiki tests against).
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    sudo \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Non-root user with a real $HOME (the install target needs ~/.config/
# and ~/.arkeon-wiki/ to be writable as a non-root user).
RUN useradd -m -s /bin/bash arkeon \
 && echo "arkeon ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/arkeon

# Pre-create the user-systemd target dirs. We do NOT call
# `loginctl enable-linger` here — at Dockerfile build time PID 1 is
# not systemd, so loginctl has nothing to talk to. The test script
# enables linger at container runtime, after systemd-as-PID-1 is up.
RUN mkdir -p /home/arkeon/.config/systemd/user \
 && chown -R arkeon:arkeon /home/arkeon

# Install Node deps INSIDE the container so native modules
# (better-sqlite3, etc.) are compiled for linux/amd64. The host's
# node_modules is built for whatever the host arch is (arm64 macOS in
# the common dev case), so we can't reuse it.
#
# We copy package metadata + lockfile, run npm ci, then expect the
# build artifacts (dist/) to be bind-mounted at runtime over the
# placeholder we COPY here. node_modules stays in the image.
COPY package.json package-lock.json /opt/arkeon-wiki/
COPY packages/arkeon/package.json /opt/arkeon-wiki/packages/arkeon/
RUN cd /opt/arkeon-wiki && npm ci --no-audit --no-fund

# Placeholder dist dir — the host bind-mounts over it at runtime.
RUN mkdir -p /opt/arkeon-wiki/packages/arkeon/dist
