// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki logs` — print or tail the daemon log file for an instance.
 */

import { createReadStream, existsSync, statSync, watch } from "node:fs";
import type { Command } from "commander";

import { applyName, isProcessAlive, logfile } from "../../lib/local-runtime.js";
import { DEFAULT_INSTANCE_NAME, findInstance } from "../../lib/instances.js";
import { output } from "../../lib/output.js";

interface LogsOptions {
  name?: string;
  follow?: boolean;
  lines?: string;
}

export function registerLogsCommand(program: Command): void {
  program
    .command("logs")
    .description("Print the daemon log for a running (or recently stopped) instance")
    .option("--name <name>", "Instance name (default: the unnamed instance)")
    .option("-f, --follow", "Tail the log and stream new lines as they arrive")
    .option("-n, --lines <n>", "Print the last N lines before any tailing", "200")
    .action(async (options: LogsOptions) => {
      try {
        await runLogs(options);
      } catch (err) {
        output.error(err, { operation: "logs" });
        process.exitCode = 1;
      }
    });
}

async function runLogs(options: LogsOptions): Promise<void> {
  if (options.name) applyName(options.name);
  const path = logfile();
  if (!existsSync(path)) {
    throw new Error(`No log file at ${path}. Has this instance ever been started?`);
  }

  const lines = Number(options.lines ?? "200");
  await printTail(path, lines);

  if (!options.follow) return;

  // Follow mode: stream new content as the file grows.
  let offset = statSync(path).size;
  const watcher = watch(path, () => {
    try {
      const size = statSync(path).size;
      if (size <= offset) {
        if (size < offset) offset = 0; // truncated/rotated
        return;
      }
      const stream = createReadStream(path, { start: offset, end: size - 1 });
      stream.on("data", (chunk) => process.stdout.write(chunk));
      stream.on("end", () => { offset = size; });
    } catch { /* transient — try again on next event */ }
  });

  // If the daemon was running when we started, watch for its death so we
  // exit cleanly instead of silently sitting on a file that will never
  // grow. Skip the check if no instance was registered (logs after stop).
  const instanceName = options.name ?? DEFAULT_INSTANCE_NAME;
  const initial = findInstance(instanceName);
  let deathCheck: NodeJS.Timeout | null = null;
  if (initial) {
    deathCheck = setInterval(() => {
      if (!isProcessAlive(initial.pid)) {
        process.stdout.write(
          `\n[arkeon-wiki] daemon (pid ${initial.pid}) exited — log will not grow further.\n`,
        );
        clearInterval(deathCheck!);
        watcher.close();
        process.exit(0);
      }
    }, 1000);
  }

  const cleanup = () => {
    if (deathCheck) clearInterval(deathCheck);
    watcher.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Keep the process alive
  await new Promise(() => { /* run forever until signal */ });
}

async function printTail(path: string, lines: number): Promise<void> {
  // For typical daemon logs (a few MB at most) just slurp + slice.
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(path, "utf-8");
  const all = text.split("\n");
  const tail = all.slice(Math.max(0, all.length - lines)).join("\n");
  process.stdout.write(tail);
  if (!tail.endsWith("\n")) process.stdout.write("\n");
}
