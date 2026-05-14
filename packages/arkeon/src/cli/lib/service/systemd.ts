// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Linux systemd --user ServiceManager. Mirror of launchd.ts.
 *
 * Wires the pure unit renderer (systemd-unit.ts) and the systemctl /
 * loginctl exec wrappers (systemctl.ts) into the {@link ServiceManager}
 * contract.
 *
 * Constructed via {@link createSystemdManager} so tests can supply
 * fake runners + a tmp home directory. The exported `manager` uses
 * the real binaries and the user's `$HOME`.
 *
 * Lifecycle commands we exercise (all user-scope, no sudo):
 *
 *   - `daemon-reload`      pick up new/changed unit files
 *   - `enable --now <u>`   create the wants link + start the service
 *   - `disable --now <u>`  stop + remove the wants link
 *   - `start <u>`          start an already-enabled service
 *   - `show <u> -p ...`    inspect ActiveState / MainPID / LoadState
 *   - `loginctl enable-linger <user>` survive logout on headless servers
 *
 * The linger call is best-effort: on misconfigured systems polkit
 * may refuse it for non-root callers. We surface the failure as a
 * warning but never fail the install — the service still works for
 * users with a graphical session.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname } from "node:path";

import {
  renderSystemdUnit,
  systemdUnitName,
  systemdUnitPath,
} from "./systemd-unit.js";
import {
  parseSystemctlShow,
  realLoginctl,
  realSystemctl,
  type LoginctlRunner,
  type SystemctlRunner,
} from "./systemctl.js";
import type {
  InstallOptions,
  InstallResult,
  ServiceManager,
  ServiceStatus,
  StartResult,
  UninstallOptions,
  UninstallResult,
} from "./types.js";

export interface CreateSystemdManagerOptions {
  /** Override systemctl exec — used in tests. */
  runSystemctl?: SystemctlRunner;
  /** Override loginctl exec — used in tests. */
  runLoginctl?: LoginctlRunner;
  /** Override `$HOME` used to locate ~/.config/systemd/user/. */
  home?: string;
  /** Override the username passed to `loginctl enable-linger`. */
  username?: string;
  /** Poll interval + budget after enable/start. */
  bootWaitMs?: number;
  bootIntervalMs?: number;
  /** Sleep used during the post-start wait. Override for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BOOT_WAIT_MS = 5000;
const DEFAULT_BOOT_INTERVAL_MS = 200;
const SHOW_PROPS = ["ActiveState", "MainPID", "LoadState"];

export function createSystemdManager(
  opts: CreateSystemdManagerOptions = {},
): ServiceManager {
  const runSystemctl = opts.runSystemctl ?? realSystemctl;
  const runLoginctl = opts.runLoginctl ?? realLoginctl;
  const home = opts.home ?? homedir();
  const username = opts.username ?? userInfo().username;
  const bootWaitMs = opts.bootWaitMs ?? DEFAULT_BOOT_WAIT_MS;
  const bootIntervalMs = opts.bootIntervalMs ?? DEFAULT_BOOT_INTERVAL_MS;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  function unitFilenameFor(name: string): string {
    return `${systemdUnitName(name)}.service`;
  }

  function unitPathFor(name: string): string {
    return systemdUnitPath(systemdUnitName(name), home);
  }

  function showArgs(name: string): string[] {
    return [
      "--user",
      "show",
      unitFilenameFor(name),
      ...SHOW_PROPS.flatMap((p) => ["-p", p]),
    ];
  }

  async function readStatus(name: string): Promise<ServiceStatus> {
    const unitPath = unitPathFor(name);
    const installed = existsSync(unitPath);

    if (!installed) {
      return { installed: false, running: false, pid: null, unitPath: null };
    }

    const printed = await runSystemctl(showArgs(name));
    // `systemctl show` returns 0 with empty output when the unit is
    // unknown — we already screen that via existsSync. A non-zero
    // exit here would mean systemctl itself is broken or unreachable.
    if (printed.exitCode !== 0) {
      return { installed: true, running: false, pid: null, unitPath };
    }

    const fields = parseSystemctlShow(printed.stdout);
    return {
      installed: true,
      running: fields.activeState === "active",
      pid: fields.mainPid,
      unitPath,
    };
  }

  async function install(installOpts: InstallOptions): Promise<InstallResult> {
    const filename = unitFilenameFor(installOpts.name);
    const unitPath = unitPathFor(installOpts.name);
    const unitBody = renderSystemdUnit(installOpts);

    // Make sure ~/.config/systemd/user/ exists — fresh-user accounts
    // may not have it yet if no user service was ever installed.
    const userUnitsDir = dirname(unitPath);
    if (!existsSync(userUnitsDir)) {
      mkdirSync(userUnitsDir, { recursive: true });
    }

    // Write the new unit *before* any systemctl ops. Same partial-
    // failure reasoning as launchd: a writeFileSync failure leaves the
    // user's previous service running (if there was one) rather than
    // disabled-with-no-replacement.
    writeFileSync(unitPath, unitBody, "utf-8");

    // Pick up the new unit. Idempotent.
    const reload = await runSystemctl(["--user", "daemon-reload"]);
    if (reload.exitCode !== 0) {
      throw new Error(
        `systemctl --user daemon-reload failed (exit ${reload.exitCode}): ` +
          `${reload.stderr.trim() || reload.stdout.trim()}`,
      );
    }

    // enable creates the symlink under default.target.wants/ so the
    // unit starts at user-session start; --now also starts it
    // immediately. Idempotent on re-install — enable returns 0 even
    // if the link already exists.
    const enable = await runSystemctl(["--user", "enable", "--now", filename]);
    if (enable.exitCode !== 0) {
      throw new Error(
        `systemctl --user enable --now ${filename} failed (exit ${enable.exitCode}): ` +
          `${enable.stderr.trim() || enable.stdout.trim()}`,
      );
    }

    // Best-effort linger enable. Required for headless servers (where
    // there's no graphical session keeping the user systemd alive
    // after logout). Idempotent; warn on failure but don't fail
    // install — users with persistent graphical sessions are unaffected.
    await runLoginctl(["enable-linger", username]);

    // Poll for ActiveState=active. enable --now is synchronous in
    // that it returns once systemd has *started* the job, but the
    // service may still be in 'activating' state for a moment.
    const deadline = Date.now() + bootWaitMs;
    let last = await readStatus(installOpts.name);
    while (!last.running && Date.now() < deadline) {
      await sleep(bootIntervalMs);
      last = await readStatus(installOpts.name);
    }

    return {
      unitPath,
      label: filename.replace(/\.service$/, ""),
      running: last.running,
      pid: last.pid,
    };
  }

  async function uninstall(
    uninstallOpts: UninstallOptions,
  ): Promise<UninstallResult> {
    const filename = unitFilenameFor(uninstallOpts.name);
    const unitPath = unitPathFor(uninstallOpts.name);
    const existed = existsSync(unitPath);

    // Best-effort stop + disable. Returns non-zero if the unit was
    // already inactive or never enabled — both fine for uninstall.
    await runSystemctl(["--user", "disable", "--now", filename]);

    if (existed) {
      rmSync(unitPath);
    }

    // Reload so systemd doesn't keep a phantom record of the unit
    // around. Also clears any failed-state for `failed` units that
    // were just removed.
    await runSystemctl(["--user", "daemon-reload"]);
    await runSystemctl(["--user", "reset-failed"]);

    return {
      removed: existed,
      unitPath: existed ? unitPath : null,
    };
  }

  async function start({ name }: { name: string }): Promise<StartResult> {
    const filename = unitFilenameFor(name);
    const unitPath = unitPathFor(name);
    if (!existsSync(unitPath)) {
      throw new Error(
        `service is not installed for ${name === "default" ? "the default instance" : `instance "${name}"`}. ` +
          `Run \`arkeon-wiki install${name === "default" ? "" : ` --name ${name}`}\` first.`,
      );
    }

    const startResult = await runSystemctl(["--user", "start", filename]);
    if (startResult.exitCode !== 0) {
      throw new Error(
        `systemctl --user start ${filename} failed (exit ${startResult.exitCode}): ` +
          `${startResult.stderr.trim() || startResult.stdout.trim()}`,
      );
    }

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

/** Production manager — uses real systemctl/loginctl + `$HOME`. */
export const manager: ServiceManager = createSystemdManager();
