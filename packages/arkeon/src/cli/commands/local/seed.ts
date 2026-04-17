// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon seed` — load the bundled Genesis knowledge graph into the
 * running stack.
 *
 * Posts the bundled Genesis ops envelope to the compatibility /ops
 * endpoint using the admin key loaded from ~/.arkeon/secrets.json.
 */

import type { Command } from "commander";

import { GENESIS_OPS } from "../../../generated/assets.js";
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

interface OpsResponse {
  format: "arke.ops/v1";
  committed: boolean;
  entities: Array<{ ref: string | null; id: string; action?: "created" }>;
  edges: Array<{ ref: string | null; id: string }>;
  stats: { entities: number; edges: number };
  errors?: unknown[];
}

export function registerSeedCommand(program: Command): void {
  program
    .command("seed")
    .description("Load the bundled Genesis knowledge graph via POST /ops")
    .option("--dry-run", "Validate the envelope and return planned IDs without writing")
    .option("--force", "Re-run even if the Genesis book entity already exists")
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

  output.progress(
    `[arkeon] Posting Genesis envelope (${GENESIS_OPS.ops.length} ops)${opts.dryRun ? " in dry-run mode" : ""}...`,
  );

  const url = `${apiUrl.replace(/\/$/, "")}/ops${opts.dryRun ? "?dry_run=true" : ""}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `ApiKey ${adminKey}`,
    },
    body: JSON.stringify(GENESIS_OPS),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(
      `POST ${url} failed: ${response.status} ${response.statusText} - ${body?.error?.message ?? "no detail"}`,
    );
  }

  const result = (await response.json()) as OpsResponse;
  const entitiesCreated = result.stats?.entities ?? result.entities?.length ?? 0;
  const edgesCreated = result.stats?.edges ?? result.edges?.length ?? 0;

  output.result({
    operation: "seed",
    dry_run: Boolean(opts.dryRun),
    committed: result.committed,
    entities_created: entitiesCreated,
    relationships_created: edgesCreated,
    errors: result.errors ?? [],
    next: "arkeon wiki list --filter properties.subject_type:book",
  });
}

async function checkGenesisBook(apiUrl: string, adminKey: string): Promise<string | null> {
  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, "")}/wiki?filter=${encodeURIComponent("properties.subject_type:book")}&limit=20`, {
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
