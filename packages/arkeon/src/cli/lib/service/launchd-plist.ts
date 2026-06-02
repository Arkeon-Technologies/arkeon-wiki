// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure renderer for the launchd LaunchAgent plist.
 *
 * The plist is the persistent state launchd reads at login. Once it
 * exists under ~/Library/LaunchAgents/ and has been bootstrapped, the
 * OS picks it up across reboots without any further action — so this
 * renderer is the *whole* persistence story for the macOS case.
 *
 * Kept separate from `launchd.ts` (the ServiceManager implementation,
 * Phase C) so the rendering surface is independently testable without
 * any launchctl involvement.
 *
 * Label scheme: `tech.arkeon.wiki` for the default instance, and
 * `tech.arkeon.wiki.<name>` for a `--name`-scoped instance. Apple's
 * convention is reverse-DNS-style; periods inside the name are fine
 * because Apple itself uses multi-segment labels like
 * `com.apple.cfprefsd.xpc.daemon`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { isDefaultName, validateInstanceName } from "./naming.js";
import type { InstallOptions } from "./types.js";

export { DEFAULT_INSTANCE_NAME, validateInstanceName } from "./naming.js";

export const DEFAULT_LAUNCHD_LABEL = "tech.arkeon.wiki";

/**
 * Derive the launchd label for a given instance name. Stable across
 * runs — used to look up the existing service via
 * `launchctl print gui/$UID/<label>` in Phase C.
 */
export function launchdLabel(name: string): string {
  validateInstanceName(name);
  return isDefaultName(name) ? DEFAULT_LAUNCHD_LABEL : `${DEFAULT_LAUNCHD_LABEL}.${name}`;
}

/**
 * Canonical install path for a launchd label. User-scoped — no sudo,
 * runs in the user's GUI session, survives login.
 */
export function launchdPlistPath(label: string, home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

/**
 * Render the plist body. Pure — no I/O. Caller writes the result to
 * the path returned by {@link launchdPlistPath}.
 *
 * The contract embedded in this template (see scoping doc §macOS for
 * the why behind each key):
 *
 *   - `RunAtLoad` + the LaunchAgents directory location together
 *     guarantee the daemon comes up at every login.
 *   - `KeepAlive` is the *dict* form, not the boolean form, so the
 *     supervisor restarts on crash but respects a clean `arkeon-wiki
 *     down` (clean exit → stays down until next `up`/login).
 *   - `EnvironmentVariables.PATH` is set explicitly because launchd's
 *     default PATH is the bare minimum and won't find homebrew binaries.
 *   - Secrets (OPENAI_API_KEY etc.) deliberately do *not* live here.
 *     They go in ~/.arkeon-wiki/.env via env-snapshot.ts so co-located
 *     harnesses can read them. Plists are world-readable on multi-user
 *     Macs — we don't want keys there.
 */
export function renderLaunchdPlist(opts: InstallOptions): string {
  const { name, home, paths } = opts;
  validateInstanceName(name);

  const label = launchdLabel(name);
  const args = isDefaultName(name)
    ? [paths.nodeBin, paths.cliEntry, "start"]
    : [paths.nodeBin, paths.cliEntry, "start", "--name", name];

  const argsXml = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const logPath = join(home, "arkeon.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(home)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>ARKEON_WIKI_HOME</key>
    <string>${xmlEscape(home)}</string>
    <key>ARKEON_WIKI_LOG_ROTATE</key>
    <string>1</string>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
`;
}

/**
 * Standard XML escaping for content nested inside `<string>...</string>`.
 * Apple's plist parser is strict — an unescaped `&` in a file path
 * produces a parse error and launchctl refuses to load it. Realistic
 * filenames rarely contain these chars, but unit-test fixtures and
 * users with `&` in their home dir name do exist, so we escape.
 */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
