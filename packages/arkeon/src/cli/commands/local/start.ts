// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki start` — bring up the local Arkeon stack.
 *
 * Flow:
 *   1. Refuse to start if already running (pidfile check).
 *   2. Create ~/.arkeon-wiki/.
 *   3. Run migrations against SQLite database.
 *   4. Start API server.
 *   5. Write pidfile and wait for SIGTERM/SIGINT.
 */

import type { Command } from "commander";
import { realpathSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";

const IS_WIN = platform() === "win32";

import {
  applyName,
  arkeonDir,
  dbPath,
  DEFAULT_API_PORT,
  ensureArkeonDir,
  isProcessAlive,
  logfile,
  readPidfile,
  removePidfile,
  writePidfile,
} from "../../lib/local-runtime.js";
import {
  DEFAULT_INSTANCE_NAME,
  registerInstance,
  unregisterInstance,
} from "../../lib/instances.js";
import { installRotatingStdLog } from "../../lib/rotating-log.js";
import { runMigrations } from "../../../schema/index.js";

interface StartOptions {
  name?: string;
  port?: string;
  watchDir?: string;
}

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description("Start the Arkeon stack (SQLite + API) on this machine")
    .option(
      "--name <name>",
      "Named instance — isolates state under ~/.arkeon-wiki/<name>/ and derives a unique port from the name",
    )
    .option("--port <port>", `API port (default: ${DEFAULT_API_PORT}, or derived from --name)`)
    .option("--watch-dir <path>", "Directory to watch (default: ARKEON_WIKI_WATCH_DIR env or cwd)")
    .action(async (options: StartOptions) => {
      await runStart(options);
    });
}

async function runStart(options: StartOptions): Promise<void> {
  const named = options.name ? applyName(options.name) : null;
  // --port wins, then named-instance derived port, then PORT env (the
  // Docker convention; the runtime image sets PORT=8062), then default.
  const apiPort = Number(
    options.port ?? named?.port ?? process.env.PORT ?? DEFAULT_API_PORT,
  );
  const instanceName = options.name ?? DEFAULT_INSTANCE_NAME;
  // Resolve + realpath so the registry stores the canonical absolute
  // path. macOS aliases `/var` → `/private/var` and `/tmp` → `/private/tmp`,
  // so a watched root specified as `/var/folders/...` won't string-match
  // a `process.cwd()` of `/private/var/folders/...`. Canonicalize both
  // sides (here, plus in instance-resolve) and the comparison just works.
  const watchedRoot = canonicalize(
    options.watchDir ?? process.env.ARKEON_WIKI_WATCH_DIR ?? process.cwd(),
  );

  const existingPid = readPidfile();
  if (existingPid && isProcessAlive(existingPid)) {
    console.error(`arkeon-wiki is already running (pid ${existingPid}). Run \`arkeon-wiki stop\` first.`);
    process.exit(1);
  }
  if (existingPid && !isProcessAlive(existingPid)) {
    removePidfile();
  }

  ensureArkeonDir();

  // Install size-capped log rotation when our parent (the `up`
  // spawner, launchd, or systemd) explicitly opts in via
  // ARKEON_WIKI_LOG_ROTATE. We can't gate on `process.stdout.isTTY`
  // because that fires for `arkeon-wiki start > my.log`, which would
  // surprisingly redirect output to ~/.arkeon-wiki/arkeon.log instead
  // of the user's chosen file. Explicit signal is safer.
  if (process.env.ARKEON_WIKI_LOG_ROTATE) {
    installRotatingStdLog(logfile());
  }

  const db = dbPath();

  console.log("[arkeon-wiki] Starting local stack");
  if (options.name) {
    console.log(`              instance:  ${options.name}`);
  }
  console.log(`              state dir: ${arkeonDir()}`);
  console.log(`              database:  ${db}`);
  console.log(`              watching:  ${watchedRoot}`);

  // --- Shutdown handler ---
  let api: { stop: () => Promise<void> } | null = null;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[arkeon-wiki] ${signal} received, shutting down...`);

    if (api) {
      try { await api.stop(); } catch (err) {
        console.warn("[arkeon-wiki] api.stop error:", (err as Error).message);
      }
    }

    // Close the database connection
    try {
      const { closeDb } = await import("../../../server/lib/sql.js");
      closeDb();
    } catch { /* ignore */ }

    unregisterInstance(instanceName);
    removePidfile();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  if (IS_WIN) {
    process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
  }

  // --- Migrations ---
  console.log("[arkeon-wiki] Running schema migrations");
  try {
    await runMigrations({ dbPath: db });
  } catch (err) {
    console.error("[arkeon-wiki] migrations failed:", err);
    process.exit(1);
  }

  // --- API ---
  console.log(`[arkeon-wiki] Starting API on port ${apiPort}`);
  const { startApi } = await import("../../../server/server.js");

  api = await startApi({
    port: apiPort,
    dbPath: db,
    watchedRoot,
  });

  writePidfile(process.pid);
  registerInstance({
    name: instanceName,
    api_url: `http://localhost:${apiPort}`,
    api_port: apiPort,
    home: arkeonDir(),
    watch_dir: watchedRoot,
    pid: process.pid,
    started_at: new Date().toISOString(),
  });

  console.log("");
  console.log("[arkeon-wiki] Ready.");
  console.log(`              API:    http://localhost:${apiPort}`);
  console.log(`              Health: http://localhost:${apiPort}/health`);
  console.log("");
  console.log("              Press Ctrl+C to stop.");
}

/**
 * Resolve `p` to an absolute path, then chase symlinks to its canonical
 * form. Falls back to plain resolve() if the path doesn't exist yet —
 * realpath throws ENOENT and we'd rather index a not-yet-created
 * directory than abort startup.
 */
function canonicalize(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}
