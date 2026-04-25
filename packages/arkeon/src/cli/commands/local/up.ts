// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki up` — start the stack as a detached background daemon, wait
 * for /health, exit. The daemon keeps running after this command returns.
 *
 * This is the recommended entry point. Under the hood it spawns
 * `arkeon-wiki start` detached with stdio piped to the instance's log
 * file. Power users running under their own supervisor (pm2, launchd,
 * systemd) can invoke `start` directly for foreground operation.
 */

import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync, readSync, statSync } from "node:fs";
import type { Command } from "commander";

import {
  applyName,
  arkeonDir,
  DEFAULT_API_PORT,
  ensureArkeonDir,
  findCliEntry,
  isPortInUse,
  isProcessAlive,
  logfile,
  readPidfile,
  removePidfile,
} from "../../lib/local-runtime.js";
import { DEFAULT_INSTANCE_NAME, findInstance } from "../../lib/instances.js";
import { output } from "../../lib/output.js";

interface UpOptions {
  name?: string;
  port?: string;
  timeout?: string;
}

export function registerUpCommand(program: Command): void {
  program
    .command("up")
    .description("Start the Arkeon stack as a detached background daemon")
    .option(
      "--name <name>",
      "Named instance — isolates state under ~/.arkeon-wiki/<name>/ and derives a unique port from the name",
    )
    .option("--port <port>", `API port (default: ${DEFAULT_API_PORT}, or derived from --name)`)
    .option("--timeout <seconds>", "How long to wait for /health before giving up", "60")
    .action(async (options: UpOptions) => {
      try {
        await runUp(options);
      } catch (err) {
        output.error(err, { operation: "up" });
        process.exitCode = 1;
      }
    });
}

async function runUp(options: UpOptions): Promise<void> {
  const named = options.name ? applyName(options.name) : null;
  const apiPort = Number(options.port ?? named?.port ?? DEFAULT_API_PORT);
  const timeoutMs = Number(options.timeout ?? "60") * 1000;

  // Refuse if a live daemon already owns the pidfile for this home.
  const existingPid = readPidfile();
  if (existingPid && isProcessAlive(existingPid)) {
    throw new Error(
      `arkeon-wiki is already running (pid ${existingPid}). ` +
        `Run \`arkeon-wiki down${options.name ? ` --name ${options.name}` : ""}\` first.`,
    );
  }
  if (existingPid && !isProcessAlive(existingPid)) {
    removePidfile();
  }

  // Fail fast if the port is already taken — otherwise the daemon would
  // crash with EADDRINUSE inside the detached child while some unrelated
  // service holding the port keeps answering /health, fooling our poller.
  if (await isPortInUse(apiPort)) {
    throw new Error(
      `Port ${apiPort} is already in use. Pick another with --port, or stop the service that's holding it.`,
    );
  }

  ensureArkeonDir();

  const logPath = logfile();
  appendFileSync(logPath, `\n=== arkeon-wiki up ${new Date().toISOString()} ===\n`);

  // Spawn `start` as a detached child running the same CLI entry as us
  // (tsx in dev, node + bundled JS in production). ARKEON_WIKI_HOME is
  // already set in our env via applyName, so the child inherits it.
  const entry = findCliEntry();
  const childArgs = [
    ...entry.args,
    "start",
    ...(options.name ? ["--name", options.name] : []),
    ...(options.port ? ["--port", options.port] : []),
  ];
  const logFd = openSync(logPath, "a");
  const child = spawn(entry.cmd, childArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();

  if (!child.pid) {
    throw new Error("Failed to spawn `start` — no child PID. Check the log for errors.");
  }

  // If the user Ctrl+Cs us before the daemon is healthy, kill the child
  // so it doesn't end up an orphan holding a port.
  const childPid = child.pid;
  let healthyYet = false;
  const cleanup = () => {
    if (healthyYet) return;
    try { process.kill(childPid, "SIGTERM"); } catch { /* gone */ }
    process.exit(1);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  output.progress(
    `[arkeon-wiki] Daemon started (pid ${child.pid}). Waiting for http://localhost:${apiPort}/health...`,
  );

  const ready = await pollHealthWithTail(
    `http://localhost:${apiPort}/health`,
    timeoutMs,
    logPath,
    childPid,
  );

  healthyYet = true;
  process.removeListener("SIGINT", cleanup);
  process.removeListener("SIGTERM", cleanup);

  if (!ready) {
    throw new Error(
      `Timed out after ${timeoutMs / 1000}s waiting for /health. ` +
        `See logs: arkeon-wiki logs${options.name ? ` --name ${options.name}` : ""}`,
    );
  }

  // The spawn() child.pid may be a wrapper (e.g. npx in dev mode); the
  // daemon registers its own pid once /health passes. Prefer that.
  const registered = findInstance(options.name ?? DEFAULT_INSTANCE_NAME);

  output.result({
    operation: "up",
    name: options.name ?? DEFAULT_INSTANCE_NAME,
    pid: registered?.pid ?? child.pid,
    api_url: `http://localhost:${apiPort}`,
    health_url: `http://localhost:${apiPort}/health`,
    state_dir: arkeonDir(),
    log: logPath,
  });
}

/**
 * Poll /health while tailing the daemon log so the user sees progress
 * lines instead of a silent wait. Bails early if the daemon process exits.
 */
async function pollHealthWithTail(
  url: string,
  timeoutMs: number,
  logPath: string,
  daemonPid: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let logOffset = 0;
  try {
    logOffset = statSync(logPath).size;
  } catch { /* file may not exist yet */ }

  const drainLog = () => {
    try {
      const size = statSync(logPath).size;
      if (size <= logOffset) return;
      const buf = Buffer.alloc(size - logOffset);
      const fd = openSync(logPath, "r");
      try {
        readSync(fd, buf, 0, buf.length, logOffset);
      } finally {
        closeSync(fd);
      }
      logOffset = size;
      for (const line of buf.toString("utf-8").split("\n")) {
        const t = line.trim();
        if (t.startsWith("[arkeon-wiki]")) output.progress(`  ${t}`);
      }
    } catch { /* file not ready */ }
  };

  while (Date.now() < deadline) {
    if (!isProcessAlive(daemonPid)) {
      drainLog();
      return false;
    }
    drainLog();
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* still booting */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
