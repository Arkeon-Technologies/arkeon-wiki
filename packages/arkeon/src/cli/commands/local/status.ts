// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Command } from "commander";

import {
  applyName,
  arkeonDir,
  DEFAULT_API_PORT,
  isProcessAlive,
  readPidfile,
  removePidfile,
} from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";

interface StatusOptions {
  name?: string;
  port?: string;
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show the local stack's process and health state")
    .option("--name <name>", "Check a named instance started with `start --name <name>`")
    .option("--port <port>", `API port to probe (default: ${DEFAULT_API_PORT}, or derived from --name)`)
    .action(async (opts: StatusOptions) => {
      try {
        await runStatus(opts);
      } catch (error) {
        output.error(error, { operation: "status" });
        process.exitCode = 1;
      }
    });
}

async function runStatus(opts: StatusOptions): Promise<void> {
  const named = opts.name ? applyName(opts.name) : null;
  const port = Number(opts.port ?? named?.port ?? DEFAULT_API_PORT);
  const apiUrl = `http://localhost:${port}`;
  const pid = readPidfile();

  if (!pid) {
    output.result({
      operation: "status",
      state: "not_running",
      state_dir: arkeonDir(),
      hint: "Run `arkeon-wiki start` to start the stack.",
    });
    process.exit(2);
  }

  if (!isProcessAlive(pid)) {
    removePidfile();
    output.result({
      operation: "status",
      state: "not_running",
      reason: "stale_pidfile",
      stale_pid: pid,
      state_dir: arkeonDir(),
    });
    process.exit(2);
  }

  const health = await probeHealth(`${apiUrl}/health`);

  if (!health) {
    output.result({
      operation: "status",
      state: "running_unhealthy",
      pid,
      api_url: apiUrl,
      health: false,
      state_dir: arkeonDir(),
    });
    process.exit(1);
  }

  output.result({
    operation: "status",
    state: "running",
    pid,
    api_url: apiUrl,
    health: true,
    state_dir: arkeonDir(),
  });
  process.exit(0);
}

async function probeHealth(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}
