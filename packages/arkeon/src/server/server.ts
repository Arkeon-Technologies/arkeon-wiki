// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Library entry point for starting the Arkeon API server in-process.
 *
 * This is the function the `arkeon start` CLI command imports. It's
 * also what `packages/api/src/index.ts` calls when the API is run
 * standalone for dev (`npm run dev -w packages/api`). Keep the thin
 * script path (index.ts) and the library path (server.ts) doing the
 * same work so there is never "but it worked when I ran it directly"
 * drift.
 *
 * The function reads config from process.env and accepts an optional
 * override object. Anything passed in the override wins over env.
 * The env fallback means existing docker / systemd setups keep working
 * unchanged — the CLI just threads values through instead of shelling.
 */

import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";

import { createApp, openApiConfig } from "./app.js";
import { ensureBootstrap } from "./lib/bootstrap.js";
import { ensureMeiliIndex, isMeilisearchConfigured } from "./lib/meilisearch.js";
import { startRetention, stopRetention } from "./lib/retention.js";

export interface ArkeonApiConfig {
  /** TCP port to bind. Default: process.env.PORT ?? 8000 */
  port?: number;
  /** Postgres URL for the runtime role. Default: process.env.DATABASE_URL */
  databaseUrl?: string;
  /** Admin API key seeded on first boot. Default: process.env.ADMIN_BOOTSTRAP_KEY */
  adminBootstrapKey?: string;
  /** Meilisearch URL. Default: process.env.MEILI_URL (unset = search disabled) */
  meiliUrl?: string;
  /** Meilisearch master key. Default: process.env.MEILI_MASTER_KEY */
  meiliMasterKey?: string;
  /**
   * Absolute path to the built explorer SPA (`packages/explorer/dist`
   * in dev; `<cli-install>/dist/explorer` when running from a published
   * CLI). If unset, the API falls back to a monorepo-relative path.
   */
  explorerDist?: string;
}

export interface ArkeonApi {
  /** The bound address info (port + host) reported by the HTTP server. */
  address: AddressInfo;
  /** Gracefully drain in-flight work and shut the server down. */
  stop: (opts?: { drainTimeoutMs?: number }) => Promise<void>;
}

/**
 * Start the Arkeon API server in-process.
 *
 * Returns a handle that can be used to stop it cleanly. Does NOT install
 * SIGTERM/SIGINT handlers — the caller is responsible for wiring those
 * up to `stop()` if desired. (The CLI installs its own handlers so it
 * can stop the child Postgres and Meili processes in the right order.)
 */
export async function startApi(config: ArkeonApiConfig = {}): Promise<ArkeonApi> {
  // First, normalize env: ARKEON_-prefixed names are the canonical
  // 12-factor convention (and the ones Kubernetes ConfigMaps / Secrets
  // will set). Bare names are kept as fallbacks so existing host-mode
  // setups and ecosystem tools (DATABASE_URL, OPENAI_API_KEY, etc.)
  // keep working unchanged. If both are set, the ARKEON_ one wins —
  // it's more specific.
  const ENV_ALIASES: Array<[string, string]> = [
    ["ARKEON_DATABASE_URL", "DATABASE_URL"],
    ["ARKEON_MIGRATION_DATABASE_URL", "MIGRATION_DATABASE_URL"],
    ["ARKEON_MEILI_URL", "MEILI_URL"],
    ["ARKEON_MEILI_MASTER_KEY", "MEILI_MASTER_KEY"],
    ["ARKEON_ADMIN_BOOTSTRAP_KEY", "ADMIN_BOOTSTRAP_KEY"],
    ["ARKEON_ENCRYPTION_KEY", "ENCRYPTION_KEY"],
    ["ARKEON_OPENAI_API_KEY", "OPENAI_API_KEY"],
    ["ARKEON_STORAGE_BACKEND", "STORAGE_BACKEND"],
    ["ARKEON_STORAGE_DIR", "STORAGE_DIR"],
    ["ARKEON_PORT", "PORT"],
  ];
  for (const [canonical, legacy] of ENV_ALIASES) {
    if (process.env[canonical] && !process.env[legacy]) {
      process.env[legacy] = process.env[canonical];
    }
  }

  // Thread explicit config overrides into env so downstream modules
  // (which read env lazily — sql.ts, meilisearch.ts, bootstrap.ts,
  // etc.) pick them up without every module needing its own config
  // plumbing.
  if (config.databaseUrl) process.env.DATABASE_URL = config.databaseUrl;
  if (config.adminBootstrapKey) process.env.ADMIN_BOOTSTRAP_KEY = config.adminBootstrapKey;
  if (config.meiliUrl) process.env.MEILI_URL = config.meiliUrl;
  if (config.meiliMasterKey) process.env.MEILI_MASTER_KEY = config.meiliMasterKey;
  if (config.explorerDist) process.env.ARKEON_EXPLORER_DIST = config.explorerDist;

  const app = createApp({
    adminKey: config.adminBootstrapKey || process.env.ADMIN_BOOTSTRAP_KEY,
  });

  await ensureBootstrap();

  if (isMeilisearchConfigured()) {
    await ensureMeiliIndex();
    console.log("Meilisearch index configured");
  } else {
    console.warn("[search] MEILI_URL not set — search endpoint will return 503");
  }

  const port = config.port ?? Number(process.env.PORT ?? 8000);
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`arkeon-api listening on http://localhost:${info.port}`);
  });

  startRetention();

  // TODO(phase-2): Start wiki background processors here:
  //   - Draft worker: polls wiki_draft_queue, calls POST /wiki with depth+1
  //   - Dedup poller: watches published wikis, finds duplicate labels/aliases, dispatches edits
  // Pattern: use setInterval like retention.ts, or a dedicated poller

  const address = server.address() as AddressInfo;

  async function stop(opts: { drainTimeoutMs?: number } = {}): Promise<void> {
    const DRAIN_TIMEOUT_MS =
      opts.drainTimeoutMs ?? (Number(process.env.DRAIN_TIMEOUT_MS) || 320_000);

    const drainPromise = (async () => {
      stopRetention();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    })();

    const timeoutPromise = new Promise<void>((resolve) =>
      setTimeout(() => {
        console.warn(`[shutdown] drain timeout (${DRAIN_TIMEOUT_MS}ms) — forcing exit`);
        resolve();
      }, DRAIN_TIMEOUT_MS),
    );

    await Promise.race([drainPromise, timeoutPromise]);
  }

  return { address, stop };
}
