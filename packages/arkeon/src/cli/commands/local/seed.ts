// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon seed` — load the bundled Genesis knowledge graph into the
 * running stack.
 *
 * The wiki-first API removed the old /ops bulk ingestion endpoint that
 * Genesis seeding depended on. Keep the command registered so users get a
 * precise error instead of a 404 against a deleted route.
 */

import type { Command } from "commander";

import { config } from "../../lib/config.js";
import {
  DEFAULT_API_PORT,
  isProcessAlive,
  loadOrCreateSecrets,
  readPidfile,
} from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";

interface SeedOptions {
  dryRun?: boolean;
  force?: boolean;
}

export function registerSeedCommand(program: Command): void {
  program
    .command("seed")
    .description("Genesis seed is unavailable in the wiki-first API")
    .option("--dry-run", "Accepted for backward-compatible parsing; seeding is unavailable")
    .option("--force", "Accepted for backward-compatible parsing; seeding is unavailable")
    .action(async (opts: SeedOptions) => {
      try {
        await runSeed(opts);
      } catch (error) {
        output.error(error, { operation: "seed" });
        process.exitCode = 1;
      }
    });
}

async function runSeed(opts: SeedOptions): Promise<void> {
  const apiUrl = resolveApiUrl();
  const secrets = loadOrCreateSecrets();
  const adminKey = secrets.adminBootstrapKey;

  // Warn (not block) if the daemon doesn't look like it's running —
  // --api-url may still point at a remote instance, so failure will
  // surface as a fetch error below.
  const pid = readPidfile();
  const running = pid !== null && isProcessAlive(pid);
  if (!running) {
    output.warn(
      "[arkeon] no local daemon running — proceeding against " + apiUrl + " anyway.",
    );
  }

  if (!opts.force && !opts.dryRun) {
    const existing = await checkGenesisBook(apiUrl, adminKey);
    if (existing) {
      output.result({
        operation: "seed",
        skipped: true,
        reason: "Genesis book entity already exists",
        book_id: existing,
        hint: "Re-run with --force to seed again (creates duplicates — see seed README).",
      });
      return;
    }
  }

  throw new Error(
    "Genesis seeding is unavailable because the wiki-first API removed POST /ops. " +
    "Seed data must be rewritten as wiki submissions before this command can run.",
  );
}

async function checkGenesisBook(apiUrl: string, adminKey: string): Promise<string | null> {
  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, "")}/wiki?filter=${encodeURIComponent("type:book")}&limit=20`, {
      headers: { authorization: `ApiKey ${adminKey}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      entities?: Array<{ id: string; properties?: Record<string, unknown> }>;
    };
    const book = body.entities?.find((e) => {
      const label = ((e.properties?.label as string | undefined) ?? "").toLowerCase();
      return label.includes("genesis");
    });
    return book?.id ?? null;
  } catch {
    return null;
  }
}

function resolveApiUrl(): string {
  // URL resolution order: --api-url flag (via preAction → ARKE_API_URL)
  // then config store, then local default.
  const env = process.env.ARKE_API_URL?.trim();
  if (env) return env;
  const stored = config.get("apiUrl");
  if (stored) return stored;
  return `http://localhost:${DEFAULT_API_PORT}`;
}
