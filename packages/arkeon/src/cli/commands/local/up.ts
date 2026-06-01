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
import { DEFAULT_INSTANCE_NAME, findInstance, findInstanceByPort } from "../../lib/instances.js";
import { output } from "../../lib/output.js";
import { findInstalledService } from "../../lib/service/index.js";

interface UpOptions {
  name?: string;
  port?: string;
  timeout?: string;
  watchDir?: string;
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
    .option("--watch-dir <path>", "Directory to watch (default: ARKEON_WIKI_WATCH_DIR env or cwd)")
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
  const instanceName = options.name ?? DEFAULT_INSTANCE_NAME;

  // If a service is installed for this instance, delegate to the
  // supervisor instead of spawning a detached child. Spawning would
  // create an orphan the supervisor doesn't track — pid in pidfile,
  // launchctl reporting state=not running, and no auto-restart.
  const service = await findInstalledService(instanceName);
  if (service) {
    if (options.port) {
      output.progress(
        `[arkeon-wiki] --port is ignored when the service is installed — the supervisor uses the port baked into the plist at install time.`,
      );
    }
    await runServiceManagedUp({
      service,
      instanceName,
      apiPort,
      timeoutMs,
      options,
    });
    return;
  }

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
    // Two named instances can hash to the same port slot. Surface that
    // case explicitly so the user knows it's a collision with another
    // arkeon-wiki, not just a generic squatter.
    const owner = findInstanceByPort(apiPort);
    if (owner && owner.name !== (options.name ?? DEFAULT_INSTANCE_NAME)) {
      throw new Error(
        `Port ${apiPort} is already in use by arkeon-wiki instance "${owner.name}" (pid ${owner.pid}). ` +
          `Two named instances hashed to the same port — pick a different --name, or pass --port to override.`,
      );
    }
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
    ...(options.watchDir ? ["--watch-dir", options.watchDir] : []),
  ];
  const logFd = openSync(logPath, "a");
  const child = spawn(entry.cmd, childArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    // ARKEON_WIKI_LOG_ROTATE tells the spawned daemon to install the
    // in-process size-capped log rotation over its stdout/stderr. We
    // opt in explicitly (not via TTY-sniffing) so foreground users
    // who pipe `arkeon-wiki start` somewhere don't get their output
    // silently redirected to ~/.arkeon-wiki/arkeon.log.
    env: { ...process.env, ARKEON_WIKI_LOG_ROTATE: "1" },
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
  const registered = findInstance(instanceName);

  output.result({
    operation: "up",
    name: instanceName,
    pid: registered?.pid ?? child.pid,
    api_url: `http://localhost:${apiPort}`,
    health_url: `http://localhost:${apiPort}/health`,
    state_dir: arkeonDir(),
    log: logPath,
    managed_by: "spawn",
  });

  // One-line nudge after the first successful detached spawn. Goes to
  // stderr so it doesn't pollute the JSON result on stdout — scripts
  // parsing the result aren't disturbed.
  output.progress(
    `[arkeon-wiki] Tip: run \`arkeon-wiki install${options.name ? ` --name ${options.name}` : ""}\` to start automatically at login + survive crashes.`,
  );
}

/**
 * Bring up the daemon via the platform's service supervisor.
 *
 * Idempotent: if the supervisor already reports the service running,
 * we just confirm /health and return. Otherwise we delegate to
 * `manager.start()` (which does `launchctl kickstart -k`), then poll
 * /health to confirm the API is actually reachable.
 *
 * Polling here is plain /health — no log tail, no orphan-cleanup. The
 * supervisor owns the process; if it crashes during boot the
 * supervisor handles the restart, not us.
 */
async function runServiceManagedUp(params: {
  service: NonNullable<Awaited<ReturnType<typeof findInstalledService>>>;
  instanceName: string;
  apiPort: number;
  timeoutMs: number;
  options: UpOptions;
}): Promise<void> {
  const { service, instanceName, apiPort, timeoutMs, options } = params;
  const healthUrl = `http://localhost:${apiPort}/health`;

  if (service.status.running) {
    const ready = await pollHealth(healthUrl, 5000);
    output.result({
      operation: "up",
      name: instanceName,
      pid: service.status.pid,
      api_url: `http://localhost:${apiPort}`,
      health_url: healthUrl,
      state_dir: arkeonDir(),
      managed_by: "service",
      state: ready ? "running" : "running_unhealthy",
      unit_path: service.status.unitPath,
    });
    return;
  }

  output.progress(
    `[arkeon-wiki] Service is installed; starting via supervisor...`,
  );

  const startResult = await service.manager.start({ name: instanceName });

  const ready = await pollHealth(healthUrl, timeoutMs);
  if (!ready) {
    throw new Error(
      `Service started via supervisor (pid ${startResult.pid ?? "?"}) but /health did not come up within ${timeoutMs / 1000}s. ` +
        `See logs: arkeon-wiki logs${options.name ? ` --name ${options.name}` : ""}`,
    );
  }

  output.result({
    operation: "up",
    name: instanceName,
    pid: startResult.pid,
    api_url: `http://localhost:${apiPort}`,
    health_url: healthUrl,
    state_dir: arkeonDir(),
    managed_by: "service",
    state: "running",
    unit_path: startResult.unitPath,
  });
}

async function pollHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* still coming up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
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
