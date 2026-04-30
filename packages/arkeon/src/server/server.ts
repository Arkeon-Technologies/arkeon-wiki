// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Library entry point for starting the Arkeon API server in-process.
 *
 * Stripped down for the filesystem-first rewrite: no Meilisearch, no
 * workers, no auth. Just Postgres + Hono API.
 */

import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";

import { createApp } from "./app.js";
import { loadAgentEnv } from "./agents/env-loader.js";
import { startAllWatchers, stopAllWatchers } from "./lib/fs-watcher.js";
import { initDb, closeDb } from "./lib/sql.js";
import { startEmbeddingWorker, type WorkerHandle } from "./lib/embedder/worker.js";

export interface ArkeonApiConfig {
  port?: number;
  dbPath?: string;
}

export interface ArkeonApi {
  address: AddressInfo;
  stop: (opts?: { drainTimeoutMs?: number }) => Promise<void>;
}

export async function startApi(config: ArkeonApiConfig = {}): Promise<ArkeonApi> {
  if (config.dbPath) {
    process.env.DATABASE_PATH = config.dbPath;
    initDb(config.dbPath);
  }

  // Load ~/.arkeon-wiki/.env so the agent runtime sees API keys when
  // the per-space scheduler invokes runAgent. (Per-repo .env layered
  // by each scheduler when its space starts.)
  loadAgentEnv();

  const app = createApp();

  const port = config.port ?? Number(process.env.PORT ?? 8000);
  const server = serve({ fetch: app.fetch, port }, (info) => {
    process.env.PORT = String(info.port);
    console.log(`arkeon-wiki listening on http://localhost:${info.port}`);
  });

  const address = server.address() as AddressInfo;

  // Start file watchers for all registered spaces
  await startAllWatchers();

  // Start the embedding worker (issue #47). Runs alongside the watcher;
  // drains embedding_queue until stop() is called. Disable entirely with
  // ARKEON_WIKI_EMBEDDINGS=0 (e.g. for tarball smoke tests that don't
  // need embeddings).
  let embeddingWorker: WorkerHandle | null = null;
  if (process.env.ARKEON_WIKI_EMBEDDINGS !== "0") {
    embeddingWorker = startEmbeddingWorker();
  }

  async function stop(opts: { drainTimeoutMs?: number } = {}): Promise<void> {
    const DRAIN_TIMEOUT_MS = opts.drainTimeoutMs ?? 10_000;

    await stopAllWatchers();
    if (embeddingWorker) await embeddingWorker.stop();
    closeDb();

    const drainPromise = new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );

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
