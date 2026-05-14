// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki install` — register the daemon with the platform's
 * service supervisor so it survives reboot and restarts on crash.
 *
 * On macOS: writes a LaunchAgent plist under ~/Library/LaunchAgents
 * and bootstraps it into the user's launchd domain. On Linux: writes
 * a user-scope systemd unit under ~/.config/systemd/user and enables
 * it via `systemctl --user enable --now`, plus `loginctl
 * enable-linger` for headless servers. User-scope on both — no sudo.
 *
 * Refuses to run while a `up`-spawned daemon already holds the port.
 * Installation includes starting the service; we want a clean handoff,
 * not a port-collision crash inside the supervisor's first launch.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";

import {
  applyName,
  arkeonDir,
  isProcessAlive,
  readPidfile,
  removePidfile,
} from "../../lib/local-runtime.js";
import { DEFAULT_INSTANCE_NAME } from "../../lib/instances.js";
import { output } from "../../lib/output.js";
import {
  detectPlatform,
  getServiceManager,
  snapshotEnv,
  snapshotPaths,
} from "../../lib/service/index.js";
import { isSystemctlAvailable } from "../../lib/service/systemctl.js";

interface InstallCliOptions {
  name?: string;
  envKey?: string[];
  // Commander's `--no-env` flag flips this to false; default is true.
  env?: boolean;
}

const DEFAULT_ENV_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"];

export function registerInstallCommand(program: Command): void {
  program
    .command("install")
    .description(
      "Install the daemon as a system service (starts at login + restarts on crash)",
    )
    .option(
      "--name <name>",
      "Install a named instance — independent of any other --name install",
    )
    .option(
      "--env-key <key>",
      "Capture this env var from the current shell into ~/.arkeon-wiki/.env if it isn't already there. Repeatable.",
      collectRepeatable,
      [] as string[],
    )
    .option("--no-env", "Skip the env-snapshot step entirely")
    .action(async (opts: InstallCliOptions) => {
      try {
        await runInstall(opts);
      } catch (err) {
        output.error(err, { operation: "install" });
        process.exitCode = 1;
      }
    });
}

function collectRepeatable(value: string, prev: string[]): string[] {
  return [...prev, value];
}

async function runInstall(opts: InstallCliOptions): Promise<void> {
  const platform = detectPlatform();
  if (platform === "unsupported") {
    throw new Error(
      `service install is not supported on this platform. ` +
        `Currently: macOS (launchd), Linux (systemd).`,
    );
  }

  // On Linux, confirm systemctl --user actually works before going
  // further. Alpine / OpenRC / WSL1 / some container init systems
  // either don't ship the binary or can't reach the user-bus — refuse
  // with actionable instructions rather than write a unit file the
  // system can't load.
  if (platform === "systemd" && !(await isSystemctlAvailable())) {
    throw new Error(
      "systemctl --user is not available on this system. " +
        "If you're on a non-systemd Linux (Alpine, Void, WSL1) the persistent service " +
        "isn't supported yet — use `arkeon-wiki up` for an ephemeral background daemon, " +
        "or wrap it in your distro's preferred supervisor (OpenRC, runit, supervisord).",
    );
  }

  const instanceName = opts.name ?? DEFAULT_INSTANCE_NAME;
  if (opts.name) applyName(opts.name);
  const home = arkeonDir();

  // Refuse to install while a `up`-spawned daemon is running on the
  // same instance. The supervisor's first start would race the
  // existing daemon for the port and crash. Asking the user to `down`
  // first is clearer than a confused half-installed state.
  const pid = readPidfile();
  if (pid && isProcessAlive(pid)) {
    throw new Error(
      `Daemon is already running (pid ${pid}). Run \`arkeon-wiki down${opts.name ? ` --name ${opts.name}` : ""}\` first, then re-run install.`,
    );
  }
  if (pid && !isProcessAlive(pid)) {
    removePidfile();
  }

  // Resolve absolute node + CLI entry paths. Throws if invoked from a
  // dev checkout without a built CLI — install needs absolute paths
  // because launchd/systemd don't inherit the user's shell PATH.
  const paths = snapshotPaths();

  // Capture API keys from the current shell into ~/.arkeon-wiki/.env
  // so the service can authenticate after a reboot when there's no
  // shell session. Idempotent: never overwrites existing values.
  const envKeys = opts.env === false
    ? []
    : Array.from(new Set([...DEFAULT_ENV_KEYS, ...(opts.envKey ?? [])]));
  const envResult = envKeys.length > 0
    ? snapshotEnv({
        keys: envKeys,
        envFilePath: join(homedir(), ".arkeon-wiki", ".env"),
      })
    : { written: [], preserved: [], missing: [], envFilePath: "" };

  output.progress(`[arkeon-wiki] platform: ${platform === "launchd" ? "macOS (launchd)" : "Linux (systemd --user)"}`);

  const manager = await getServiceManager(platform);
  const result = await manager.install({
    name: instanceName,
    home,
    paths,
  });

  output.result({
    operation: "install",
    name: instanceName,
    platform,
    unit_path: result.unitPath,
    label: result.label,
    running: result.running,
    pid: result.pid,
    env: envResult.envFilePath
      ? {
          file: envResult.envFilePath,
          written: envResult.written,
          preserved: envResult.preserved,
          missing: envResult.missing,
        }
      : { skipped: true },
    next_steps:
      envResult.missing.length > 0
        ? [
            `Missing keys: ${envResult.missing.join(", ")}. Add them to ${envResult.envFilePath} or set them in the shell where you ran install before retrying.`,
          ]
        : undefined,
  });
}
