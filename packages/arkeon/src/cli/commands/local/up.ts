// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon up` — start the stack as a detached background daemon, wait
 * for /health, apply any pending LLM config, save credentials, exit.
 *
 * Shape of the flow:
 *   1. Refuse if a live daemon already owns the pidfile
 *   2. Ensure ~/.arkeon-wiki, load or generate secrets
 *   3. Spawn `arkeon start` as a detached child with stdio piped to
 *      ~/.arkeon-wiki/arkeon.log (append). The child writes the pidfile
 *      once the API is listening. The daemon reads LLM config from
 *      ~/.arkeon-wiki/llm.json directly — no threading needed here.
 *   4. Poll http://localhost:<port>/health with a 120s deadline.
 *      On timeout, tail the log and surface it.
 *   5. Save credentials so subsequent `arkeon entities list` etc. are
 *      auto-authenticated against this stack.
 *   6. Print a JSON result + exit 0; the detached child keeps running.
 */

import type { Command } from "commander";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

import { config } from "../../lib/config.js";
import { credentials } from "../../lib/credentials.js";
import { listInstances, registerInstance, saveInstanceActor, unregisterInstance } from "../../lib/instances.js";
import {
  DEFAULT_API_PORT,
  DEFAULT_MEILI_PORT,
  DEFAULT_PG_PORT,
  arkeonDir,
  ensureArkeonDir,
  findCliEntry,
  isPortInUse,
  isProcessAlive,
  loadOrCreateSecrets,
  logfile,
  probeLlmConfig,
  readPidfile,
  removePidfile,
} from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";

interface UpOptions {
  name?: string;
  port?: string;
  pgPort?: string;
  meiliPort?: string;
  timeout?: string;
}

/**
 * Deterministic port slot from instance name. Maps to slot 1-999.
 * Uses two bytes of the hash for a wider range (reduces collision probability).
 */
function nameToPortSlot(name: string): number {
  const hash = createHash("sha256").update(name).digest();
  return ((hash[0]! << 8 | hash[1]!) % 999) + 1;
}

export function registerUpCommand(program: Command): void {
  program
    .command("up")
    .description("Start the Arkeon stack as a detached background daemon, wait for health")
    .option("--name <name>", "Named instance — auto-picks ports and isolates state in ~/.arkeon-wiki/<name>/")
    .option("--port <port>", `API port (default: ${DEFAULT_API_PORT})`)
    .option("--pg-port <port>", `Embedded Postgres port (default: ${DEFAULT_PG_PORT})`)
    .option("--meili-port <port>", `Meilisearch port (default: ${DEFAULT_MEILI_PORT})`)
    .option("--timeout <seconds>", "Health-check timeout in seconds", "120")
    .action(async (opts: UpOptions) => {
      try {
        await runUp(opts);
      } catch (error) {
        output.error(error, { operation: "up" });
        process.exitCode = 1;
      }
    });
}

async function runUp(opts: UpOptions): Promise<void> {
  const instanceName = opts.name ?? "default";
  const isNamed = Boolean(opts.name);
  const timeoutMs = (Number.parseInt(opts.timeout ?? "120", 10) || 120) * 1000;

  // Prune stale registry entries from crashed instances
  for (const inst of listInstances()) {
    if (!isProcessAlive(inst.pid)) {
      unregisterInstance(inst.api_port);
    }
  }

  // Resolve ports and ARKEON_WIKI_HOME
  let apiPort: number;
  let pgPort: number;
  let meiliPort: number;

  if (isNamed) {
    const slot = nameToPortSlot(instanceName);
    apiPort = Number(opts.port ?? DEFAULT_API_PORT + slot);
    pgPort = Number(opts.pgPort ?? DEFAULT_PG_PORT + slot);
    meiliPort = Number(opts.meiliPort ?? DEFAULT_MEILI_PORT + 10000 + slot);

    // Check for port collision with another named instance
    if (!opts.port) {
      const existing = listInstances().find((i) => i.api_port === apiPort && i.name !== instanceName && isProcessAlive(i.pid));
      if (existing) {
        throw new Error(
          `Port ${apiPort} is already in use by instance "${existing.name}". ` +
          `Use --port to pick a different port: arkeon up --name ${instanceName} --port ${apiPort + 1}`,
        );
      }
    }

    // Named instances get isolated state under ~/.arkeon-wiki/<name>/
    process.env.ARKEON_WIKI_HOME = process.env.ARKEON_WIKI_HOME ?? join(homedir(), ".arkeon-wiki", instanceName);
    output.progress(`[arkeon] Starting named instance "${instanceName}" — API=${apiPort}, PG=${pgPort}, Meili=${meiliPort}`);
    output.progress(`[arkeon] State dir: ${process.env.ARKEON_WIKI_HOME}`);
  } else {
    apiPort = Number(opts.port ?? DEFAULT_API_PORT);
    pgPort = Number(opts.pgPort ?? DEFAULT_PG_PORT);
    meiliPort = Number(opts.meiliPort ?? DEFAULT_MEILI_PORT);

    // Check if there's already a running instance on this port
    const running = listInstances().filter((i) => isProcessAlive(i.pid));
    if (running.length > 0 && !opts.port) {
      const list = running.map((i) => `  ${i.name} — ${i.api_url} (pid ${i.pid})`).join("\n");
      throw new Error(
        `An Arkeon instance is already running:\n${list}\n\n` +
        `To start an additional instance, use: arkeon up --name <name>\n` +
        `To stop one: arkeon down <name>`,
      );
    }
  }

  const existingPid = readPidfile();
  if (existingPid && isProcessAlive(existingPid)) {
    throw new Error(
      `arkeon is already running (pid ${existingPid}). Use \`arkeon status\` to check, or \`arkeon down\` to stop it first.`,
    );
  }
  if (existingPid && !isProcessAlive(existingPid)) {
    // Stale pidfile from a crash or kill -9 — clean it up and continue.
    removePidfile();
  }

  ensureArkeonDir();
  const secrets = loadOrCreateSecrets();

  // If any of our ports are busy (e.g. orphaned services from a previous
  // crash, or another dev server), auto-bump to the next available port
  // rather than spawning a daemon that silently can't bind. Only
  // auto-resolve ports the user didn't explicitly set.
  apiPort = await resolvePort(apiPort, "API", !opts.port);
  pgPort = await resolvePort(pgPort, "Postgres", !opts.pgPort);
  meiliPort = await resolvePort(meiliPort, "Meilisearch", !opts.meiliPort);

  output.progress(`[arkeon] Starting stack in ${arkeonDir()}...`);

  // Append a boot marker so operators tailing the log can tell runs apart.
  const logPath = logfile();
  try {
    appendFileSync(logPath, `\n\n=== arkeon up ${new Date().toISOString()} ===\n`);
  } catch {
    // ignore — writePidfile later in the child will surface real issues
  }

  // Spawn `arkeon start` as a detached child. The child runs the same
  // CLI entry (either tsx on the monorepo source or node on the bundled
  // dist) so there's no version skew between the parent (this process)
  // and the daemon.
  //
  // Argument order matters: everything AFTER entry.args is consumed by
  // the arkeon command parser, so the arkeon-level --data-dir has to go
  // between the entry args and the `start` subcommand — if we put it
  // before entry.args, `npx` would interpret it as one of its own
  // flags and fail.
  const entry = findCliEntry();
  const dataDirArgs = process.env.ARKEON_WIKI_HOME
    ? ["--data-dir", process.env.ARKEON_WIKI_HOME]
    : [];
  const childArgs = [
    ...entry.args,
    ...dataDirArgs,
    "start",
    "--port", String(apiPort),
    "--pg-port", String(pgPort),
    "--meili-port", String(meiliPort),
  ];
  // fd-based redirect so the child's stdout/stderr append to arkeon.log
  // without leaving a pipe open on our side. Parent can exit freely.
  const logFd = openSync(logPath, "a");

  // In monorepo-dev mode the entry is `npx tsx <path>`; npx needs a
  // package.json to resolve `tsx` from, so we have to run from the
  // project root, not from whatever cwd the user invoked us in (which
  // might be anywhere, including a directory that doesn't exist
  // from the child's perspective). Anchor to the repo root by
  // deriving it from the entry path.
  const childCwd = deriveChildCwd(entry);

  // In dev mode, explicitly pass the explorer dist path so the daemon
  // serves the correct build (not one from a sibling worktree or parent repo).
  const explorerDistEnv: Record<string, string> = {};
  if (!process.env.ARKEON_EXPLORER_DIST) {
    const candidateDist = join(childCwd, "packages", "explorer", "dist");
    if (existsSync(candidateDist)) {
      explorerDistEnv.ARKEON_EXPLORER_DIST = candidateDist;
    }
  }

  // LLM config is read directly from ~/.arkeon-wiki/llm.json by the daemon
  // (see packages/arkeon/src/server/lib/llm.ts). Nothing to thread.

  const child = spawn(entry.cmd, childArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: childCwd,
    env: {
      ...process.env,
      ...explorerDistEnv,
    },
  });

  child.unref();

  if (!child.pid) {
    throw new Error("Failed to spawn arkeon start — no child PID. Check `arkeon logs` for errors.");
  }

  // If the parent is interrupted (Ctrl+C) before the daemon is healthy,
  // kill the detached child so it doesn't become an orphan holding ports.
  const childPid = child.pid;
  let healthyYet = false;
  const cleanupOnExit = () => {
    if (healthyYet) return;
    try { process.kill(childPid, "SIGTERM"); } catch { /* already gone */ }
    process.exit(1);
  };
  process.on("SIGINT", cleanupOnExit);
  process.on("SIGTERM", cleanupOnExit);

  output.progress(`[arkeon] Daemon started (child pid ${child.pid}). Waiting for /health...`);

  // Poll /health while tailing the daemon log so the user sees progress.
  const healthOk = await pollHealthWithProgress(
    `http://localhost:${apiPort}/health`,
    timeoutMs,
    logPath,
    childPid,
  );

  healthyYet = true;
  process.removeListener("SIGINT", cleanupOnExit);
  process.removeListener("SIGTERM", cleanupOnExit);

  if (!healthOk) {
    const tail = safeTail(logPath, 50);
    throw new Error(
      `Timed out waiting for http://localhost:${apiPort}/health after ${timeoutMs / 1000}s.\n\n` +
      `Last log lines:\n${tail}`,
    );
  }

  // Register this instance so other commands can discover it.
  const apiUrl = `http://localhost:${apiPort}`;
  registerInstance({
    name: instanceName,
    api_url: apiUrl,
    api_port: apiPort,
    arkeon_home: arkeonDir(),
    pid: child.pid,
    started_at: new Date().toISOString(),
  });

  // Register admin actor in the instance actor registry so `arkeon auth use admin` works.
  try {
    const meResp = await fetch(`${apiUrl}/auth/me`, {
      headers: { authorization: `ApiKey ${secrets.adminBootstrapKey}` },
    });
    if (meResp.ok) {
      const meBody = (await meResp.json()) as { actor?: { id?: string } };
      if (meBody.actor?.id) {
        saveInstanceActor(apiUrl, "admin", meBody.actor.id);
        credentials.saveActorKey(meBody.actor.id, secrets.adminBootstrapKey, "admin");
      }
    }
  } catch {
    // Non-fatal — admin profile just won't be available
  }

  // Wire up the CLI for the user: point at the local instance and
  // store the admin bootstrap key as the active API key.
  config.set("apiUrl", apiUrl);
  credentials.save({
    apiKey: secrets.adminBootstrapKey,
    keyPrefix: secrets.adminBootstrapKey.slice(0, 8),
  });

  const llm = probeLlmConfig();
  if (!llm.configured) {
    output.progress("");
    output.progress("[arkeon] LLM not configured — extraction and drafting workers are disabled.");
    output.progress("         Set a key:  arkeon-wiki config set-llm-key <your-api-key>");
    output.progress("         Then restart: arkeon-wiki down && arkeon-wiki up");
  }

  output.result({
    operation: "up",
    api_url: apiUrl,
    explorer_url: `${apiUrl}/explore`,
    health_url: `${apiUrl}/health`,
    ready_url: `${apiUrl}/ready`,
    admin_key_stored: true,
    admin_key_prefix: `${secrets.adminBootstrapKey.slice(0, 8)}...`,
    llm_configured: llm.configured,
    logs_hint: "arkeon logs",
    next: "arkeon seed",
  });
}

/**
 * If the requested port is busy and the user didn't explicitly request it,
 * scan upward for the next free port (up to 20 attempts). If the user did
 * explicitly set the port, throw a clear error instead of silently changing it.
 */
async function resolvePort(port: number, label: string, autoResolve: boolean): Promise<number> {
  if (!(await isPortInUse(port))) return port;

  if (!autoResolve) {
    throw new Error(
      `${label} port ${port} is already in use (you requested it with --port/--pg-port/--meili-port).\n` +
      `Free the port or pick a different one.`,
    );
  }

  for (let candidate = port + 1; candidate < port + 20; candidate++) {
    if (!(await isPortInUse(candidate))) {
      output.progress(`[arkeon] ${label} port ${port} in use, using ${candidate} instead`);
      return candidate;
    }
  }
  throw new Error(`${label} port ${port} is in use and no free port found in range ${port + 1}–${port + 19}.`);
}

/**
 * Poll /health while tailing the daemon log so the user sees progress
 * instead of a silent wait. Filters for `[arkeon]` and `[meili]` prefixed
 * lines to surface the daemon's startup milestones. If the daemon process
 * exits before health succeeds, bail early rather than waiting the full
 * timeout.
 */
async function pollHealthWithProgress(
  url: string,
  timeoutMs: number,
  logPath: string,
  daemonPid: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  // Track where we are in the log file so we only print new lines.
  let logOffset = 0;
  try {
    logOffset = statSync(logPath).size;
  } catch {
    // file may not exist yet
  }

  const drainLog = () => {
    try {
      const size = statSync(logPath).size;
      if (size <= logOffset) return;
      // Positional read: open, read only the new bytes, close.
      // Avoids reading the entire log file every 500ms.
      const bytesToRead = size - logOffset;
      const buf = Buffer.alloc(bytesToRead);
      const fd = openSync(logPath, "r");
      try {
        readSync(fd, buf, 0, bytesToRead, logOffset);
      } finally {
        closeSync(fd);
      }
      logOffset = size;

      for (const line of buf.toString("utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Surface daemon milestone lines to the user.
        if (
          trimmed.startsWith("[arkeon]") ||
          trimmed.startsWith("[meili]") ||
          trimmed.startsWith("[bootstrap]")
        ) {
          output.progress(`  ${trimmed}`);
        }
      }
    } catch {
      // log not ready or read error — skip this cycle
    }
  };

  while (Date.now() < deadline) {
    // Check if daemon is still alive — bail early if it crashed.
    if (!isProcessAlive(daemonPid)) {
      drainLog();
      output.progress("[arkeon] Daemon process exited unexpectedly.");
      return false;
    }

    drainLog();

    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // still booting
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Pick a cwd for the detached child that is guaranteed to work:
 *   - Monorepo dev (npx tsx <path>): use the directory containing
 *     the package.json that `tsx` belongs to — that's the workspace
 *     root a few levels up from packages/cli/src/index.ts.
 *   - Bundled dist (node <path>): use the directory holding the
 *     bundled index.js — a `package.json` sibling exists after install.
 *
 * Using the current process cwd would fail when the user invokes
 * `arkeon up` from an unrelated directory (e.g. a scratch folder
 * passed via --data-dir that has no package.json for npx to resolve
 * tsx from).
 *
 * IMPORTANT: In a git worktree layout, worktrees are nested inside
 * the main repo (e.g. .claude/worktrees/<name>/). A naive walk-up
 * can escape the worktree and find node_modules in the parent repo
 * or a sibling worktree, causing the daemon to load the wrong code.
 * We stop the walk at the worktree boundary to prevent this.
 */
function deriveChildCwd(entry: { cmd: string; args: string[] }): string {
  // The arg that points at our code is either "tsx" followed by a
  // script path (monorepo dev) or a single path (bundled).
  const scriptArg =
    entry.args[0] === "tsx" && entry.args[1] ? entry.args[1] : entry.args[0];
  if (!scriptArg) return process.cwd();

  const abs = resolve(scriptArg);
  // Walk up looking for a node_modules directory. In a workspace
  // layout, this resolves to the monorepo root (where npm hoists
  // everything), so `npx tsx` from that cwd finds the binary. In a
  // global npm install, it resolves to the install prefix.
  //
  // Stop walking if we hit a worktree boundary — don't escape into
  // the parent repo or sibling worktrees.
  const WORKTREE_MARKERS = [".claude/worktrees/", ".claude-worktrees/"];
  let dir = dirname(abs);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "node_modules"))) return dir;
    // If this directory IS a worktree root, don't walk past it
    const parent = dirname(dir);
    if (WORKTREE_MARKERS.some((m) => parent.endsWith(m.slice(0, -1)) || dir.includes(m))) {
      // We're inside a worktree — if we haven't found node_modules yet,
      // use process.cwd() (the user ran the command from the worktree root)
      if (existsSync(join(process.cwd(), "node_modules"))) return process.cwd();
    }
    dir = dirname(dir);
  }
  // Fallback: first ancestor with package.json (handles edge cases
  // where node_modules is symlinked from elsewhere).
  dir = dirname(abs);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

function safeTail(path: string, lines: number): string {
  try {
    if (!existsSync(path)) return "(log file not found)";
    const text = readFileSync(path, "utf-8");
    const split = text.split("\n");
    return split.slice(Math.max(0, split.length - lines)).join("\n");
  } catch (error) {
    return `(failed to read log: ${(error as Error).message})`;
  }
}
