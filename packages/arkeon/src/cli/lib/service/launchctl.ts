// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin wrapper around `execFile("launchctl", ...)`.
 *
 * Surfaces stdout/stderr/exitCode together so callers can decide
 * what's "success" — launchctl has dozens of exit codes that aren't
 * uniformly "0 = good, anything else = bad" (e.g., 17 = "service
 * already loaded" which we usually want to ignore-and-retry, 113 =
 * "service not found" which is the expected state during uninstall).
 *
 * Exposed as a function type so the manager can be constructed with a
 * fake runner in tests — no real launchctl invocation outside an
 * actual `arkeon-wiki install` run.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LaunchctlResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type LaunchctlRunner = (args: string[]) => Promise<LaunchctlResult>;

/**
 * Production runner. Resolves the result regardless of exit code so the
 * caller can branch on it.
 */
export const realLaunchctl: LaunchctlRunner = async (args) => {
  try {
    const { stdout, stderr } = await execFileAsync("launchctl", args, {
      // Generous buffer for `launchctl print`, which can dump a few KB
      // of service metadata in verbose form.
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
      // execFile sets `code` to the exit code; type is `number | string`
      // (ENOENT-style errors expose a string code). Coerce defensively.
      exitCode: typeof e.code === "number" ? e.code : -1,
    };
  }
};

/**
 * Parse the output of `launchctl print gui/$UID/<label>` into the
 * fields we care about. The output is multi-line freeform; we look for
 * lines matching `state = ...` and `pid = ...`. Indentation and
 * whitespace vary across macOS releases — we strip leading whitespace
 * before matching.
 *
 * When the service isn't loaded at all, `print` returns a non-zero
 * exit code and a message like "Could not find service". Callers
 * should treat that as `{loaded: false}` before invoking this parser.
 */
export interface LaunchctlPrintFields {
  state: "running" | "not running" | "unknown";
  pid: number | null;
}

export function parseLaunchctlPrint(stdout: string): LaunchctlPrintFields {
  let state: LaunchctlPrintFields["state"] = "unknown";
  let pid: number | null = null;

  // `launchctl print` repeats the substring `state = ...` inside nested
  // blocks for `resource coalition` and `jetsam coalition` (their state
  // is the literal string "active"). The service's own `state = ` line
  // appears before any nested block, so the FIRST match wins and we
  // never overwrite. Same defensive policy for `pid = ` — the
  // top-level pid line appears before any nested process listings.
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (state === "unknown") {
      const stateMatch = trimmed.match(/^state\s*=\s*(.+)$/);
      if (stateMatch) {
        const v = stateMatch[1]!.trim();
        if (v === "running") state = "running";
        else if (v === "not running") state = "not running";
        // Any other value (e.g. "active" from nested coalition blocks)
        // we leave as "unknown" — but only on the first match. Subsequent
        // state lines never overwrite a real running/not-running answer.
        continue;
      }
    }
    if (pid === null) {
      const pidMatch = trimmed.match(/^pid\s*=\s*(\d+)$/);
      if (pidMatch) pid = Number(pidMatch[1]);
    }
  }

  return { state, pid };
}
