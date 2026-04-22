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

export interface ArkeonApiConfig {
  port?: number;
  databaseUrl?: string;
}

export interface ArkeonApi {
  address: AddressInfo;
  stop: (opts?: { drainTimeoutMs?: number }) => Promise<void>;
}

export async function startApi(config: ArkeonApiConfig = {}): Promise<ArkeonApi> {
  if (config.databaseUrl) process.env.DATABASE_URL = config.databaseUrl;

  const app = createApp();

  const port = config.port ?? Number(process.env.PORT ?? 8000);
  const server = serve({ fetch: app.fetch, port }, (info) => {
    process.env.PORT = String(info.port);
    console.log(`arkeon-wiki listening on http://localhost:${info.port}`);
  });

  const address = server.address() as AddressInfo;

  async function stop(opts: { drainTimeoutMs?: number } = {}): Promise<void> {
    const DRAIN_TIMEOUT_MS = opts.drainTimeoutMs ?? 10_000;

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
