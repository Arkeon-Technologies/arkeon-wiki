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
import { startAllWatchers, stopAllWatchers } from "./lib/fs-watcher.js";
import { initDb, closeDb } from "./lib/sql.js";

export interface ArkeonApiConfig {
  port?: number;
  dbPath?: string;
  /**
   * Interface to bind to. Defaults to `127.0.0.1` (loopback only) so a
   * daemon on a multi-tenant host or a workstation on an untrusted LAN
   * isn't reachable from elsewhere. Override with `ARKEON_WIKI_HOST`
   * (e.g. `0.0.0.0` to listen on all interfaces, `::` for IPv6 wildcard,
   * or a specific bind address) when an operator deliberately wants the
   * daemon to be reachable cross-host.
   *
   * The daemon has no auth — anything that can reach the port can write
   * to the corpus AND (since /sources/from-url) trigger arbitrary
   * outbound HTTP(S) GETs from the daemon's network position. Loopback
   * is the only safe default.
   */
  hostname?: string;
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

  const app = createApp();

  const port = config.port ?? Number(process.env.PORT ?? 8000);
  const hostname =
    config.hostname ?? process.env.ARKEON_WIKI_HOST ?? "127.0.0.1";

  // Wait for the listen callback so `server.address()` is non-null
  // before we read it. With an explicit hostname the bind is async
  // enough that reading the address synchronously after `serve()`
  // returns null (the omitted-hostname code path happened to bind
  // synchronously, so this wasn't needed before).
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port, hostname }, (info) => {
      process.env.PORT = String(info.port);
      // Display "localhost" only when bound to loopback — otherwise show
      // the actual bind so the operator notices a public-facing daemon.
      const displayHost =
        hostname === "127.0.0.1" || hostname === "::1" ? "localhost" : hostname;
      console.log(`arkeon-wiki listening on http://${displayHost}:${info.port}`);
      resolve(s);
    });
  });

  const address = server.address() as AddressInfo;

  // Start file watchers for all registered spaces
  await startAllWatchers();

  async function stop(opts: { drainTimeoutMs?: number } = {}): Promise<void> {
    const DRAIN_TIMEOUT_MS = opts.drainTimeoutMs ?? 10_000;

    await stopAllWatchers();
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
