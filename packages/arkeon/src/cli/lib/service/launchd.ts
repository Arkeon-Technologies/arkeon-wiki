// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * macOS launchd ServiceManager.
 *
 * Wires the pure plist renderer (launchd-plist.ts) and the launchctl
 * exec wrapper (launchctl.ts) into the {@link ServiceManager}
 * contract.
 *
 * Constructed via {@link createLaunchdManager} so tests can supply a
 * fake launchctl + a tmp `home` directory. The exported `manager`
 * uses the real launchctl and the user's `$HOME`.
 *
 * Lifecycle commands we exercise:
 *
 *   - `bootstrap gui/$UID <plist>`   load + start (boot-time + login)
 *   - `bootout    gui/$UID/<label>`  stop + unload (clean shutdown)
 *   - `kickstart  -k gui/$UID/<label>`  hard-restart (used to ensure
 *                                       a freshly-bootstrapped service
 *                                       is actually running)
 *   - `print      gui/$UID/<label>`  inspect state (running/pid)
 *
 * The `gui/$UID` domain is the modern (macOS 10.10+) replacement for
 * `launchctl load -w`. User-scope; no sudo.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import {
  launchdLabel,
  launchdPlistPath,
  renderLaunchdPlist,
} from "./launchd-plist.js";
import {
  parseLaunchctlPrint,
  realLaunchctl,
  type LaunchctlRunner,
} from "./launchctl.js";
import type {
  InstallOptions,
  InstallResult,
  ServiceManager,
  ServiceStatus,
  StartResult,
  UninstallOptions,
  UninstallResult,
} from "./types.js";

export interface CreateLaunchdManagerOptions {
  /** Override the launchctl executor — used in tests. */
  runLaunchctl?: LaunchctlRunner;
  /** Override `$HOME` used to locate the LaunchAgents directory. */
  home?: string;
  /** Override UID. Defaults to `process.getuid()`. */
  uid?: number;
  /** Poll interval + budget after bootstrap, in ms. */
  bootWaitMs?: number;
  bootIntervalMs?: number;
  /** Sleep used during the post-bootstrap wait. Override for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BOOT_WAIT_MS = 5000;
const DEFAULT_BOOT_INTERVAL_MS = 200;

export function createLaunchdManager(
  opts: CreateLaunchdManagerOptions = {},
): ServiceManager {
  const run = opts.runLaunchctl ?? realLaunchctl;
  const home = opts.home ?? homedir();
  const uid = opts.uid ?? process.getuid?.() ?? -1;
  const bootWaitMs = opts.bootWaitMs ?? DEFAULT_BOOT_WAIT_MS;
  const bootIntervalMs = opts.bootIntervalMs ?? DEFAULT_BOOT_INTERVAL_MS;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  function domain(label: string): string {
    return `gui/${uid}/${label}`;
  }

  function plistPathFor(name: string): string {
    return launchdPlistPath(launchdLabel(name), home);
  }

  async function readStatus(name: string): Promise<ServiceStatus> {
    const label = launchdLabel(name);
    const unitPath = plistPathFor(name);
    const installed = existsSync(unitPath);

    if (!installed) {
      return { installed: false, running: false, pid: null, unitPath: null };
    }

    const printed = await run(["print", domain(label)]);
    if (printed.exitCode !== 0) {
      // Plist on disk but not loaded — common between `bootout` and
      // the next bootstrap. Report installed-but-not-running.
      return { installed: true, running: false, pid: null, unitPath };
    }

    const fields = parseLaunchctlPrint(printed.stdout);
    return {
      installed: true,
      running: fields.state === "running",
      pid: fields.pid,
      unitPath,
    };
  }

  async function install(installOpts: InstallOptions): Promise<InstallResult> {
    const label = launchdLabel(installOpts.name);
    const unitPath = plistPathFor(installOpts.name);
    const plistBody = renderLaunchdPlist(installOpts);

    // Make sure ~/Library/LaunchAgents/ exists — fresh-user Macs may
    // not have it yet if no third-party tool ever wrote a LaunchAgent.
    const launchAgentsDir = dirname(unitPath);
    if (!existsSync(launchAgentsDir)) {
      mkdirSync(launchAgentsDir, { recursive: true });
    }

    // Write the new plist *before* tearing down the previous load.
    // If writeFileSync throws (disk full, EACCES, etc.) the user's
    // previous service is left running — a re-runnable failure.
    // If we bootout'd first and then failed to write, the user would
    // be left with a stopped service and no new plist to retry from.
    writeFileSync(unitPath, plistBody, "utf-8");

    // If the service is already loaded (re-install with new plist
    // contents, or a stale entry from a previous build), bootout
    // first so bootstrap can take the fresh plist. Ignore failures —
    // bootout returns non-zero when the service wasn't loaded, which
    // is the happy path on a first install.
    await run(["bootout", domain(label)]);

    const bootstrap = await run(["bootstrap", `gui/${uid}`, unitPath]);
    if (bootstrap.exitCode !== 0) {
      throw new Error(
        `launchctl bootstrap failed (exit ${bootstrap.exitCode}): ` +
          `${bootstrap.stderr.trim() || bootstrap.stdout.trim()}`,
      );
    }

    // Some macOS releases bootstrap-then-skip-Run-At-Load if the
    // service was loaded earlier in the session. `kickstart -k` is the
    // belt-and-braces way to guarantee an actual running process; the
    // -k flag means "kill any existing instance first" which is safe
    // because we just bootstrapped fresh.
    await run(["kickstart", "-k", domain(label)]);

    // Poll for `state = running`. Bootstrap is synchronous in name
    // only — the child process spawns asynchronously, and on a cold
    // box the daemon needs a moment to bind the API port. We give it
    // bootWaitMs; if we time out, we still return — the caller can
    // call `arkeon-wiki status` later to confirm.
    const deadline = Date.now() + bootWaitMs;
    let last = await readStatus(installOpts.name);
    while (!last.running && Date.now() < deadline) {
      await sleep(bootIntervalMs);
      last = await readStatus(installOpts.name);
    }

    return {
      unitPath,
      label,
      running: last.running,
      pid: last.pid,
    };
  }

  async function uninstall(
    uninstallOpts: UninstallOptions,
  ): Promise<UninstallResult> {
    const label = launchdLabel(uninstallOpts.name);
    const unitPath = plistPathFor(uninstallOpts.name);
    const existed = existsSync(unitPath);

    // bootout is best-effort — if the service wasn't loaded, it
    // returns non-zero, which is fine for the uninstall path. We just
    // want to ensure nothing is running under this label after we
    // delete the file.
    await run(["bootout", domain(label)]);

    if (existed) {
      rmSync(unitPath);
    }

    return {
      removed: existed,
      unitPath: existed ? unitPath : null,
    };
  }

  async function start({ name }: { name: string }): Promise<StartResult> {
    const label = launchdLabel(name);
    const unitPath = plistPathFor(name);
    if (!existsSync(unitPath)) {
      throw new Error(
        `service is not installed for ${name === "default" ? "the default instance" : `instance "${name}"`}. ` +
          `Run \`arkeon-wiki install${name === "default" ? "" : ` --name ${name}`}\` first.`,
      );
    }

    // kickstart -k = "kill any existing process, then start". Safe
    // because we only call start() when the supervisor's view of state
    // is "not running", and harmless when it's actually running.
    await run(["kickstart", "-k", domain(label)]);

    const deadline = Date.now() + bootWaitMs;
    let last = await readStatus(name);
    while (!last.running && Date.now() < deadline) {
      await sleep(bootIntervalMs);
      last = await readStatus(name);
    }

    return {
      running: last.running,
      pid: last.pid,
      unitPath,
    };
  }

  return {
    install,
    uninstall,
    status: ({ name }) => readStatus(name),
    start,
  };
}

/** Production manager — uses real launchctl + `$HOME`. */
export const manager: ServiceManager = createLaunchdManager();
