// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure renderer for the systemd --user unit file.
 *
 * The unit is the persistent state systemd reads at user-session
 * start. Once it exists under ~/.config/systemd/user/ and has been
 * enabled, systemd picks it up across reboots (with
 * `loginctl enable-linger` covering headless servers where there's no
 * graphical session).
 *
 * Mirror of `launchd-plist.ts` — same shape, same separation of
 * "render" from "manage the supervisor." Phase C wires this through
 * the ServiceManager interface; this file is pure.
 *
 * Unit naming:
 *   - default:  `arkeon-wiki.service`
 *   - --name X: `arkeon-wiki-X.service`
 *
 * We use concrete unit files per name rather than systemd's
 * `arkeon-wiki@.service` template syntax — templates buy convenience
 * for cookie-cutter use cases, but our per-name install needs to set
 * `WorkingDirectory` and `ExecStart --name <X>` together, which
 * templates with `%i` make readable only at the cost of two unit
 * forms (one for the default, one for the template). Simpler to emit
 * one self-contained unit per instance.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { isDefaultName, validateInstanceName } from "./naming.js";
import type { InstallOptions } from "./types.js";

export { DEFAULT_INSTANCE_NAME, validateInstanceName } from "./naming.js";

export const UNIT_PREFIX = "arkeon-wiki";

/**
 * Derive the systemd unit name (without the `.service` suffix —
 * `systemctl --user` accepts both forms, but the bare name is more
 * common in user-facing output).
 */
export function systemdUnitName(name: string): string {
  validateInstanceName(name);
  return isDefaultName(name) ? UNIT_PREFIX : `${UNIT_PREFIX}-${name}`;
}

/**
 * Canonical user-scope unit path: `~/.config/systemd/user/<unit>.service`.
 * `home` defaults to the real `$HOME`; tests can pass a tmp dir.
 */
export function systemdUnitPath(unit: string, home: string = homedir()): string {
  return join(home, ".config", "systemd", "user", `${unit}.service`);
}

/**
 * Render the unit body. Pure — no I/O. Caller writes the result to
 * the path returned by {@link systemdUnitPath}.
 *
 * Embedded contract (see scoping doc §Linux for the why):
 *
 *   - `Type=simple` — the daemon never daemonizes; it's a long-running
 *     foreground process from systemd's POV. Same effective shape as
 *     macOS launchd, which also runs the process directly.
 *   - `Restart=on-failure` parallels launchd's
 *     `KeepAlive: { Crashed: true, SuccessfulExit: false }` — clean
 *     `arkeon-wiki down` (exit code 0) stays down; signal or non-zero
 *     exit triggers a restart after `RestartSec=10`.
 *   - `WantedBy=default.target` — the user-mode equivalent of
 *     `multi-user.target`; ensures the unit starts when the user's
 *     session does (or when lingering kicks in on headless boot).
 *   - `EnvironmentFile=-<path>` (leading dash) — load if present,
 *     don't fail if absent. Two of them so both `~/.arkeon-wiki/.env`
 *     (user-global) and `<home>/.env` (per-instance) work.
 *   - Secrets (OPENAI_API_KEY etc.) deliberately do NOT live here —
 *     they go in `~/.arkeon-wiki/.env` via env-snapshot.ts, the
 *     agent runtime loads them at startup. Unit files are 0644 by
 *     default and live in a directory other users can traverse; keys
 *     belong in the 0600 env file.
 */
export function renderSystemdUnit(opts: InstallOptions): string {
  const { name, home, paths } = opts;
  validateInstanceName(name);

  const description = isDefaultName(name)
    ? "Arkeon Wiki daemon"
    : `Arkeon Wiki daemon (${name})`;
  const userGlobalEnv = join(homedir(), ".arkeon-wiki", ".env");
  const perInstanceEnv = join(home, ".env");
  const logPath = join(home, "arkeon.log");

  // ExecStart is whitespace-tokenized — `/home/foo bar/node` parses
  // as executable `/home/foo` + arg `bar/node`. The instance-name
  // validator rejects spaces, but the snapshotted paths (nvm node
  // binary, dist/index.js) can live anywhere, including dirs with
  // spaces. Quote each token to keep the unit correct for those
  // users.
  //
  // systemd recognizes double-quoted strings in ExecStart since v240+
  // (Debian 11+, Ubuntu 20.04+, RHEL 8+) and treats `\"` as an
  // embedded quote. We escape both backslashes and quotes.
  const argTokens = isDefaultName(name)
    ? [paths.nodeBin, paths.cliEntry, "start"]
    : [paths.nodeBin, paths.cliEntry, "start", "--name", name];
  const startArgs = argTokens.map(quoteExecArg).join(" ");

  return `[Unit]
Description=${description}
After=network.target

[Service]
Type=simple
ExecStart=${startArgs}
WorkingDirectory=${home}
Environment=ARKEON_WIKI_HOME=${home}
Environment=ARKEON_WIKI_LOG_ROTATE=1
EnvironmentFile=-${userGlobalEnv}
EnvironmentFile=-${perInstanceEnv}
Restart=on-failure
RestartSec=10
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

/**
 * Quote a single ExecStart argument for systemd. Wraps the value in
 * double quotes and escapes backslashes and embedded quotes. Skips
 * quoting when the value contains only safe characters — keeps unit
 * files readable for the common case.
 */
function quoteExecArg(value: string): string {
  if (/^[A-Za-z0-9_./:@+\-]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
