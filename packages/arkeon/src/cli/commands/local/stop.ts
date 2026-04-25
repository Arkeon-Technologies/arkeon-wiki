// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Command } from "commander";
import { platform } from "node:os";

import {
  applyName,
  isProcessAlive,
  readPidfile,
  removePidfile,
} from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";

interface StopOptions {
  name?: string;
  timeout: string;
}

export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop the running Arkeon instance")
    .option("--name <name>", "Stop a named instance started with `start --name <name>`")
    .option("--timeout <ms>", "How long to wait for graceful shutdown", "30000")
    .action(async (options: StopOptions) => {
      await runStop(options);
    });
}

async function runStop(options: StopOptions): Promise<void> {
  if (options.name) applyName(options.name);

  const pid = readPidfile();
  if (!pid) {
    output.result({ operation: "stop", state: "not_running", reason: "no_pidfile" });
    return;
  }
  if (!isProcessAlive(pid)) {
    removePidfile();
    output.result({ operation: "stop", state: "not_running", reason: "stale_pidfile", pid });
    return;
  }

  output.progress(`[arkeon-wiki] Stopping pid ${pid}...`);
  try {
    if (platform() === "win32") {
      process.kill(pid);
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch (err) {
    output.error(err, { operation: "stop" });
    process.exit(1);
  }

  const timeoutMs = Number(options.timeout);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      removePidfile();
      output.result({ operation: "stop", state: "stopped", pid });
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  output.error(
    new Error(`pid ${pid} did not exit within ${timeoutMs}ms.`),
    { operation: "stop" },
  );
  process.exit(1);
}
