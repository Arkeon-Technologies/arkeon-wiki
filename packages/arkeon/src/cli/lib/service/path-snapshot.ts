// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve absolute paths to the node binary and CLI entry script for
 * use in a launchd plist or systemd unit.
 *
 * The supervisor's PATH is *not* the user's interactive shell PATH —
 * launchd's default is `/usr/bin:/bin:/usr/sbin:/sbin`, and systemd
 * user units inherit the session manager's environment, not the
 * login shell's. nvm/fnm/asdf-managed nodes are reachable only via
 * shell init scripts, so a unit that says `ExecStart=node ...` will
 * fail to find node under launchd/systemd on most developer machines.
 *
 * We pin the absolute path at install time. If the user later
 * uninstalls that node version, the service fails fast with a clear
 * ENOENT in the log — better than silently picking up a different
 * node from somewhere on PATH.
 */

import { resolve } from "node:path";

import { findCliEntry } from "../local-runtime.js";

import type { PathSnapshot } from "./types.js";

/**
 * Resolve absolute paths for the supervisor to invoke.
 *
 * Production (npm-installed): consumes the bundled `dist/index.js`
 * that `findCliEntry()` already finds; the `cmd` it returns is
 * `process.execPath` (absolute), and the entry is an absolute path
 * within the package's install dir. Both are stable for the lifetime
 * of the install.
 *
 * Dev mode (tsx running .ts directly): `findCliEntry()` returns `npx
 * tsx <path>`, which won't work under a service supervisor that
 * doesn't share the user's shell PATH. We refuse rather than guess —
 * install is a production action, and asking the user to run `npm run
 * build` first is clearer than silently shipping a broken plist.
 */
export function snapshotPaths(): PathSnapshot {
  const entry = findCliEntry();

  if (entry.cmd === "npx" || entry.cmd === "arkeon-wiki") {
    throw new Error(
      "service install requires a built CLI. " +
        "Run `npm run build` from a source checkout, or install via `npm install -g arkeon-wiki`.",
    );
  }

  const cliEntry = entry.args[0];
  if (!cliEntry) {
    throw new Error(
      "service install: could not resolve absolute CLI entry path from findCliEntry().",
    );
  }

  return {
    nodeBin: resolve(entry.cmd),
    cliEntry: resolve(cliEntry),
  };
}
