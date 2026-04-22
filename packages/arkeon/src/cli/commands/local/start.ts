// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki start` — bring up the local Arkeon stack.
 *
 * Flow:
 *   1. Refuse to start if already running (pidfile check).
 *   2. Create ~/.arkeon-wiki/, load or generate secrets.
 *   3. Start embedded Postgres.
 *   4. Run migrations.
 *   5. Start API server.
 *   6. Write pidfile and wait for SIGTERM/SIGINT.
 */

import type { Command } from "commander";
import { platform } from "node:os";

const IS_WIN = platform() === "win32";

import {
  arkeonDir,
  DEFAULT_API_PORT,
  DEFAULT_PG_PORT,
  ensureArkeonDir,
  isProcessAlive,
  killOrphanedPostgres,
  loadOrCreateSecrets,
  readPidfile,
  removePidfile,
  startEmbeddedPostgres,
  writePidfile,
} from "../../lib/local-runtime.js";
import { runMigrations } from "../../../schema/index.js";

interface StartOptions {
  port?: string;
  pgPort?: string;
}

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description("Start the Arkeon stack (Postgres + API) on this machine")
    .option("--port <port>", "API port", String(DEFAULT_API_PORT))
    .option("--pg-port <port>", "Embedded Postgres port", String(DEFAULT_PG_PORT))
    .action(async (options: StartOptions) => {
      await runStart(options);
    });
}

async function runStart(options: StartOptions): Promise<void> {
  const apiPort = Number(options.port ?? DEFAULT_API_PORT);
  const pgPort = Number(options.pgPort ?? DEFAULT_PG_PORT);

  const externalDatabaseUrl =
    process.env.ARKEON_DATABASE_URL ?? process.env.DATABASE_URL;

  const existingPid = readPidfile();
  if (existingPid && isProcessAlive(existingPid) && !externalDatabaseUrl) {
    console.error(`arkeon-wiki is already running (pid ${existingPid}). Run \`arkeon-wiki stop\` first.`);
    process.exit(1);
  }
  if (existingPid && !isProcessAlive(existingPid)) {
    removePidfile();
  }

  ensureArkeonDir();
  const secrets = loadOrCreateSecrets();

  console.log("[arkeon-wiki] Starting local stack");
  console.log(`              state dir: ${arkeonDir()}`);

  // --- Shutdown handler ---
  let pg: { url: string; stop: () => Promise<void> } | null = null;
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
    if (pg) {
      try { await pg.stop(); } catch (err) {
        console.warn("[arkeon-wiki] pg stop error:", (err as Error).message);
      }
    }
    removePidfile();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  if (IS_WIN) {
    process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
  }

  // --- Postgres ---
  let dbUrl: string;

  if (externalDatabaseUrl) {
    console.log(`[arkeon-wiki] Using external Postgres (DATABASE_URL set)`);
    dbUrl = externalDatabaseUrl;
  } else {
    await killOrphanedPostgres();
    console.log(`[arkeon-wiki] Starting embedded Postgres on port ${pgPort}`);
    pg = await startEmbeddedPostgres({
      port: pgPort,
      password: secrets.pgPassword,
    });
    dbUrl = pg.url;
  }

  // --- Migrations ---
  console.log("[arkeon-wiki] Running schema migrations");
  try {
    await runMigrations({ databaseUrl: dbUrl });
  } catch (err) {
    console.error("[arkeon-wiki] migrations failed:", err);
    if (pg) await pg.stop();
    process.exit(1);
  }

  // --- API ---
  console.log(`[arkeon-wiki] Starting API on port ${apiPort}`);
  const { startApi } = await import("../../../server/server.js");

  api = await startApi({
    port: apiPort,
    databaseUrl: dbUrl,
  });

  writePidfile(process.pid);

  console.log("");
  console.log("[arkeon-wiki] Ready.");
  console.log(`              API:    http://localhost:${apiPort}`);
  console.log(`              Health: http://localhost:${apiPort}/health`);
  console.log("");
  console.log("              Press Ctrl+C to stop.");
}
