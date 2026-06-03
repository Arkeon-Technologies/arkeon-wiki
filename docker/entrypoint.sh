#!/bin/sh
# Copyright (c) 2026 Arkeon Technologies, Inc.
# SPDX-License-Identifier: Apache-2.0
#
# arkeon-wiki container entrypoint.
#
# 1. Remap the `arkeon` user to PUID/PGID so files written into /state
#    (SQLite DB, logs) match the host's expected owner. /watch is a
#    bind mount — we trust the host's ownership there and never chown.
# 2. exec arkeon-wiki <args> as the arkeon user via gosu. Defaults to
#    `start` (foreground daemon mode) when no args are passed.

set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

current_uid="$(id -u arkeon)"
current_gid="$(id -g arkeon)"

if [ "$PGID" != "$current_gid" ]; then
    groupmod -o -g "$PGID" arkeon
fi
if [ "$PUID" != "$current_uid" ]; then
    usermod -o -u "$PUID" arkeon
fi

# Re-own the writable state dir + read-only image dirs the runtime touches.
# Skip /watch deliberately — host owns it, we shouldn't recursively chown
# a corpus that might be millions of files.
if [ "$PUID" != "$current_uid" ] || [ "$PGID" != "$current_gid" ]; then
    chown -R "$PUID:$PGID" /state /opt/arkeon-wiki /home/arkeon
fi

# Allow `docker run image bash` / `docker run image --help` to work
# naturally: if the first arg looks like a flag or isn't an executable
# on PATH, prepend `arkeon-wiki`.
if [ "$#" -eq 0 ] || [ "${1#-}" != "$1" ] || ! command -v "$1" >/dev/null 2>&1; then
    set -- arkeon-wiki "$@"
fi

exec gosu arkeon "$@"
