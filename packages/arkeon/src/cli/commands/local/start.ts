// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon start` — bring up the full local Arkeon stack.
 *
 * Flow:
 *   1. Refuse to start if an instance is already running (pidfile check).
 *   2. Create ~/.arkeon/, load or generate secrets.
 *   3. Ensure the Meilisearch binary is downloaded and executable.
 *   4. Start embedded Postgres.
 *   6. Run migrations.
 *   7. Start Meilisearch.
 *   8. Call startApi() in-process, wired to those services.
 *   9. Write the pidfile and wait for SIGTERM/SIGINT.
 *
 * On shutdown, we stop in reverse order: API drain → Meili stop →
 * Postgres stop → pidfile removed. A failure at any layer still attempts
 * the remaining teardown so we don't leak child processes.
 */

import type { Command } from "commander";
import { type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const IS_WIN = platform() === "win32";

import {
  arkeonDir,
  DEFAULT_API_PORT,
  DEFAULT_MEILI_PORT,
  DEFAULT_PG_PORT,
  filesDataDir,
  ensureArkeonDir,
  ensureMeiliBinary,
  isProcessAlive,
  killOrphanedMeilisearch,
  killOrphanedPostgres,
  loadOrCreateSecrets,
  readPidfile,
  removeMeiliPidfile,
  removePidfile,
  startEmbeddedPostgres,
  startMeilisearch,
  waitForMeilisearchReady,
  writePidfile,
} from "../../lib/local-runtime.js";
import { runMigrations } from "../../../schema/index.js";

interface StartOptions {
  port?: string;
  pgPort?: string;
  meiliPort?: string;
}

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description("Start the Arkeon stack (Postgres + Meilisearch + API) on this machine")
    .option("--port <port>", "API port", String(DEFAULT_API_PORT))
    .option("--pg-port <port>", "Embedded Postgres port", String(DEFAULT_PG_PORT))
    .option("--meili-port <port>", "Meilisearch port", String(DEFAULT_MEILI_PORT))
    .action(async (options: StartOptions) => {
      await runStart(options);
    });
}

async function runStart(options: StartOptions): Promise<void> {
  const apiPort = Number(options.port ?? DEFAULT_API_PORT);
  const pgPort = Number(options.pgPort ?? DEFAULT_PG_PORT);
  const meiliPort = Number(options.meiliPort ?? DEFAULT_MEILI_PORT);

  // "Bring your own" escape hatches. If either is set we skip the
  // corresponding embedded service and just point the API at the URL.
  // ARKEON_-prefixed names are the forward-looking convention; bare
  // names stay for back-compat with existing host-mode setups and the
  // broader ecosystem (things like `DATABASE_URL` are conventional in
  // Postgres tooling).
  const externalDatabaseUrl =
    process.env.ARKEON_DATABASE_URL ?? process.env.DATABASE_URL;
  const externalMigrationUrl =
    process.env.ARKEON_MIGRATION_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL;
  const externalMeiliUrl =
    process.env.ARKEON_MEILI_URL ?? process.env.MEILI_URL;
  const externalMeiliKey =
    process.env.ARKEON_MEILI_MASTER_KEY ?? process.env.MEILI_MASTER_KEY;

  // Refuse to start if a prior arkeon on this machine is still running.
  // Only applies to the embedded path — external-services mode is
  // stateless on disk and can run multiple copies side by side.
  const existingPid = readPidfile();
  if (existingPid && isProcessAlive(existingPid) && !externalDatabaseUrl) {
    console.error(`arkeon is already running (pid ${existingPid}). Run \`arkeon stop\` first.`);
    process.exit(1);
  }
  if (existingPid && !isProcessAlive(existingPid)) {
    // Stale pidfile from a crashed/killed instance — clean up and continue.
    removePidfile();
  }

  ensureArkeonDir();
  const secrets = loadOrCreateSecrets();

  console.log("[arkeon] Starting local stack");
  console.log(`         state dir: ${arkeonDir()}`);

  // --- Shutdown handler ---
  // Registered early so that a SIGTERM/SIGINT received while services are
  // still starting up will tear down whatever has been started so far,
  // instead of leaving orphaned Postgres/Meilisearch processes.
  let pg: { appUrl: string; superUrl: string; stop: () => Promise<void> } | null = null;
  let meili: ChildProcess | null = null;
  let api: { stop: () => Promise<void> } | null = null;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[arkeon] ${signal} received, shutting down…`);

    if (api) {
      try { await api.stop(); } catch (err) {
        console.warn("[arkeon] api.stop error:", (err as Error).message);
      }
    }
    if (meili) {
      try {
        const child = meili;
        await new Promise<void>((resolve) => {
          let resolved = false;
          const done = () => { if (!resolved) { resolved = true; resolve(); } };
          child.once("exit", done);
          try {
            if (IS_WIN) { child.kill(); } else { child.kill("SIGTERM"); }
          } catch { done(); return; }
          setTimeout(done, 5000);
        });
      } catch (err) {
        console.warn("[arkeon] meili stop error:", (err as Error).message);
      }
    }
    if (pg) {
      try { await pg.stop(); } catch (err) {
        console.warn("[arkeon] pg stop error:", (err as Error).message);
      }
    }
    removePidfile();
    removeMeiliPidfile();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  if (IS_WIN) {
    process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
  }

  // --- Postgres ---
  // In embedded mode (default) we boot a Postgres cluster inside
  // ~/.arkeon/data/postgres. In external mode the user is responsible
  // for provisioning the database; we only run migrations against it.
  let dbAppUrl: string;
  let migrationUrl: string;

  if (externalDatabaseUrl) {
    console.log(`[arkeon] Using external Postgres (DATABASE_URL set)`);
    dbAppUrl = externalDatabaseUrl;
    migrationUrl = externalMigrationUrl ?? externalDatabaseUrl;
    // In external mode the DBA has already created the arke_app role
    // with whatever password they chose. We must NOT let migrate.js
    // re-ALTER it to our generated password. Pull ARKE_APP_PASSWORD
    // from the env — the operator supplies it alongside DATABASE_URL.
    if (!process.env.ARKE_APP_PASSWORD && !process.env.ARKEON_ARKE_APP_PASSWORD) {
      console.error(
        "[arkeon] ARKE_APP_PASSWORD must be set when using an external database — " +
        "this is the password of the arke_app role in your Postgres instance.",
      );
      process.exit(1);
    }
    process.env.ARKE_APP_PASSWORD =
      process.env.ARKE_APP_PASSWORD ?? process.env.ARKEON_ARKE_APP_PASSWORD!;
  } else {
    await killOrphanedPostgres();
    console.log(`[arkeon] Starting embedded Postgres on port ${pgPort}`);
    pg = await startEmbeddedPostgres({
      port: pgPort,
      password: secrets.pgPassword,
    });
    dbAppUrl = pg.appUrl;
    migrationUrl = pg.superUrl;
    // ARKE_APP_PASSWORD has to match what migrate.js wrote to the
    // arke_app role — migrations applied it later in this same run.
    process.env.ARKE_APP_PASSWORD = secrets.pgPassword;
  }

  // --- Migrations ---
  console.log("[arkeon] Running schema migrations");
  try {
    await runMigrations({
      databaseUrl: migrationUrl,
      arkeAppPassword: process.env.ARKE_APP_PASSWORD!,
    });
  } catch (err) {
    console.error("[arkeon] migrations failed:", err);
    if (pg) await pg.stop();
    process.exit(1);
  }

  // --- Meilisearch ---
  // Same escape hatch: if MEILI_URL is set we skip downloading and
  // spawning the binary and just pass the URL through to the API.
  let meiliUrlForApi: string;
  let meiliKeyForApi: string;

  if (externalMeiliUrl) {
    console.log(`[arkeon] Using external Meilisearch (MEILI_URL set)`);
    meiliUrlForApi = externalMeiliUrl;
    meiliKeyForApi = externalMeiliKey ?? "";
  } else {
    await killOrphanedMeilisearch();
    await ensureMeiliBinary();
    console.log(`[arkeon] Starting Meilisearch on port ${meiliPort}`);
    const child = startMeilisearch({
      port: meiliPort,
      masterKey: secrets.meiliMasterKey,
    });
    meili = child;
    try {
      await waitForMeilisearchReady(meiliPort, secrets.meiliMasterKey);
    } catch (err) {
      console.error("[arkeon] Meilisearch failed to start:", err);
      if (IS_WIN) { child.kill(); } else { child.kill("SIGTERM"); }
      if (pg) await pg.stop();
      process.exit(1);
    }
    meiliUrlForApi = `http://127.0.0.1:${meiliPort}`;
    meiliKeyForApi = secrets.meiliMasterKey;
  }

  // --- API ---
  console.log(`[arkeon] Starting API on port ${apiPort}`);
  // Lazy import: loading the API eagerly would pull in every route,
  // schema, etc. on every CLI command (including `arkeon stop`), which
  // is pointless. Doing it here keeps `arkeon --help` and the unrelated
  // commands cheap.
  const { startApi } = await import("../../../server/server.js");
  const storageDir = filesDataDir();
  // Thread storage location via env so src/server/lib/storage.ts
  // writes uploaded files into the ~/.arkeon state dir rather than the
  // process cwd.
  process.env.STORAGE_BACKEND = process.env.STORAGE_BACKEND ?? "local";
  process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? storageDir;
  process.env.ARKEON_LOCAL = "true";

  const explorerDist = findExplorerDist();
  if (!explorerDist) {
    console.warn(
      "[arkeon] Explorer assets not found — /explore will 404.",
    );
    console.warn(
      "         Run `npm run build -w packages/explorer` then retry.",
    );
  }

  // Admin bootstrap key: env wins over generated secret so operators
  // can pin a fixed key (e.g. injected from Kubernetes Secrets) instead
  // of chasing a randomly-generated one each deploy.
  const adminBootstrapKey =
    process.env.ARKEON_ADMIN_BOOTSTRAP_KEY ??
    process.env.ADMIN_BOOTSTRAP_KEY ??
    secrets.adminBootstrapKey;

  api = await startApi({
    port: apiPort,
    databaseUrl: dbAppUrl,
    adminBootstrapKey,
    meiliUrl: meiliUrlForApi,
    meiliMasterKey: meiliKeyForApi,
    explorerDist: explorerDist ?? undefined,
  });

  writePidfile(process.pid);

  console.log("");
  console.log("[arkeon] Ready.");
  console.log(`         API:       http://localhost:${apiPort}`);
  console.log(`         Explorer:  http://localhost:${apiPort}/explore`);
  console.log(`         Health:    http://localhost:${apiPort}/health`);
  console.log(`         Ready:     http://localhost:${apiPort}/ready`);
  console.log(`         Admin key: ${adminBootstrapKey}`);
  console.log("");
  console.log("         Press Ctrl+C to stop.");
}

/**
 * Locate the built explorer SPA assets. Layout depends on how the CLI
 * was invoked:
 *   - Monorepo dev (tsx): `import.meta.url` points at
 *     packages/arkeon/src/cli/commands/local/start.ts. The explorer
 *     dist lives at packages/explorer/dist — up 5 levels then into
 *     explorer/dist.
 *   - Bundled CLI (tsup): everything collapses into
 *     packages/arkeon/dist/index.js. copy-explorer.ts drops the assets
 *     in packages/arkeon/dist/explorer, a sibling of the bundle.
 *   - Published npm: same as bundled — the arkeon dist ships with an
 *     `explorer` subdirectory included via `files`.
 */
function findExplorerDist(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Monorepo dev: packages/arkeon/src/cli/commands/local → up 5 to packages/ → explorer/dist
    join(here, "..", "..", "..", "..", "..", "explorer", "dist"),
    // Bundled CLI / published npm — `here` is packages/arkeon/dist
    join(here, "explorer"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
