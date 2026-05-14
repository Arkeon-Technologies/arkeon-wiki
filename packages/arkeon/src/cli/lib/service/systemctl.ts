// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin wrappers around `execFile("systemctl", ...)` and
 * `execFile("loginctl", ...)`. Mirror of launchctl.ts.
 *
 * systemctl exit codes are more meaningful than launchctl's, but we
 * still surface stdout/stderr/exitCode together so the manager can
 * branch on specific states (e.g., `LoadState=not-found` is exit 0,
 * `is-active` of an inactive unit is exit 3 — both are "expected" in
 * the uninstall path).
 *
 * Exposed as function types so the manager can be constructed with
 * fake runners in tests — no real systemctl/loginctl invocation
 * outside an actual install run.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SystemctlResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type SystemctlRunner = (args: string[]) => Promise<SystemctlResult>;
export type LoginctlRunner = (args: string[]) => Promise<SystemctlResult>;

/**
 * Build a real exec runner around a specific binary. Resolves the
 * result regardless of exit code so the caller can branch on it.
 */
function makeRunner(binary: string): SystemctlRunner {
  return async (args) => {
    try {
      const { stdout, stderr } = await execFileAsync(binary, args, {
        maxBuffer: 4 * 1024 * 1024,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message,
        exitCode: typeof e.code === "number" ? e.code : -1,
      };
    }
  };
}

export const realSystemctl: SystemctlRunner = makeRunner("systemctl");
export const realLoginctl: LoginctlRunner = makeRunner("loginctl");

/**
 * Probe whether `systemctl --user` works on this machine. Returns
 * false on non-systemd Linux (Alpine, slim containers, OpenRC/runit
 * distros) where the binary is missing or the user-bus isn't
 * available — install should refuse with actionable manual
 * instructions rather than fall through to a cryptic exec error.
 *
 * The probe is `systemctl --user --version`, which:
 *   - exits 0 with version banner when systemctl is installed and
 *     the user-bus is reachable
 *   - exits ENOENT (-1 here, after our error wrap) when the binary
 *     isn't installed at all
 *   - exits non-zero with a clear error when systemctl exists but
 *     systemd isn't pid 1 (e.g., WSL1, some container init systems)
 */
export async function isSystemctlAvailable(
  run: SystemctlRunner = realSystemctl,
): Promise<boolean> {
  const result = await run(["--user", "--version"]);
  return result.exitCode === 0;
}

/**
 * Parsed slice of `systemctl --user show <unit>` output. We ask for
 * the specific properties we care about via `-p ActiveState -p
 * MainPID -p LoadState`, and parse the resulting key=value lines.
 *
 * Output shape:
 *
 *   ActiveState=active
 *   MainPID=12345
 *   LoadState=loaded
 *
 * Stable across systemd versions; no nested-block surprise like
 * launchctl's "state = active" inside coalition blocks.
 */
export interface SystemctlShowFields {
  /** Service runtime state: active = running, inactive/failed = not. */
  activeState: "active" | "inactive" | "failed" | "activating" | "deactivating" | "unknown";
  /** PID of the main process, or null when no process is running. */
  mainPid: number | null;
  /** Unit-file state: loaded = enabled and known, not-found = absent. */
  loadState: "loaded" | "not-found" | "masked" | "unknown";
}

export function parseSystemctlShow(stdout: string): SystemctlShowFields {
  let activeState: SystemctlShowFields["activeState"] = "unknown";
  let mainPid: number | null = null;
  let loadState: SystemctlShowFields["loadState"] = "unknown";

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (key === "ActiveState") {
      if (
        value === "active" ||
        value === "inactive" ||
        value === "failed" ||
        value === "activating" ||
        value === "deactivating"
      ) {
        activeState = value;
      }
    } else if (key === "MainPID") {
      const pid = Number(value);
      // systemctl reports MainPID=0 when no process is running. Coerce
      // that to null so callers don't accidentally treat 0 as a real
      // pid (kill -0 0 is a process-group check, not a no-op).
      mainPid = Number.isFinite(pid) && pid > 0 ? pid : null;
    } else if (key === "LoadState") {
      if (value === "loaded" || value === "not-found" || value === "masked") {
        loadState = value;
      }
    }
  }

  return { activeState, mainPid, loadState };
}
