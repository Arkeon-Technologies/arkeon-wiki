// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon seed` — load the bundled Genesis demonstration wikis into the
 * running stack.
 *
 * Posts each bundled wiki page to POST /wiki using the admin key from
 * ~/.arkeon-wiki/secrets.json. The pages use [[placeholder:...]] links to
 * demonstrate how the wiki pipeline creates entities and relationships.
 */

import type { Command } from "commander";

import { GENESIS_WIKIS } from "../../../generated/assets.js";
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

interface WikiResponse {
  wiki: { id: string; properties?: Record<string, unknown> };
  placeholders: Array<{ id: string; label: string; status: string }>;
  relationships_created: number;
  resolve_warnings?: unknown[];
}

export function registerSeedCommand(program: Command): void {
  program
    .command("seed")
    .description("Load the bundled Genesis demonstration wikis")
    .option("--dry-run", "Validate the first wiki without writing (quick format check)")
    .option("--force", "Re-run even if the Genesis book wiki already exists")
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
        reason: "Genesis book wiki already exists",
        book_id: existing,
        hint: "Re-run with --force to seed again (creates duplicates).",
      });
      return;
    }
  }

  const wikis = GENESIS_WIKIS;

  if (opts.dryRun) {
    output.progress(
      `[arkeon] Dry-run: would create ${wikis.length} wiki pages.`,
    );
    output.result({
      operation: "seed",
      dry_run: true,
      committed: false,
      wikis_planned: wikis.length,
      labels: wikis.map((w) => w.label),
    });
    return;
  }

  // Ensure a space exists — POST /wiki requires one.
  // On a fresh stack there are no spaces, so create a default.
  const spaceId = await ensureDefaultSpace(apiUrl, adminKey);

  output.progress(
    `[arkeon] Seeding ${wikis.length} Genesis wiki pages...`,
  );

  let totalPlaceholders = 0;
  let totalRelationships = 0;
  const createdWikis: Array<{ id: string; label: string }> = [];

  for (const wiki of wikis) {
    const url = `${apiUrl.replace(/\/$/, "")}/wiki`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `ApiKey ${adminKey}`,
      },
      body: JSON.stringify({ ...wiki, space_id: spaceId }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      throw new Error(
        `POST /wiki failed for "${wiki.label}": ${response.status} ${response.statusText} - ${body?.error?.message ?? "no detail"}`,
      );
    }

    const result = (await response.json()) as WikiResponse;
    createdWikis.push({ id: result.wiki.id, label: wiki.label });
    totalPlaceholders += result.placeholders?.length ?? 0;
    totalRelationships += result.relationships_created ?? 0;
  }

  output.result({
    operation: "seed",
    dry_run: false,
    committed: true,
    wikis_created: createdWikis.length,
    placeholders_created: totalPlaceholders,
    relationships_created: totalRelationships,
    wikis: createdWikis,
    next: "arkeon wiki list",
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

async function ensureDefaultSpace(apiUrl: string, adminKey: string): Promise<string> {
  const base = apiUrl.replace(/\/$/, "");
  // Check if any space exists
  const listRes = await fetch(`${base}/spaces`, {
    headers: { authorization: `ApiKey ${adminKey}` },
  });
  if (listRes.ok) {
    const body = (await listRes.json()) as { spaces?: Array<{ id: string }> };
    if (body.spaces && body.spaces.length > 0) {
      return body.spaces[0]!.id;
    }
  }
  // Create one
  const createRes = await fetch(`${base}/spaces`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `ApiKey ${adminKey}`,
    },
    body: JSON.stringify({ name: "default" }),
  });
  if (!createRes.ok) {
    throw new Error(`Failed to create default space: ${createRes.status}`);
  }
  const created = (await createRes.json()) as { space: { id: string } };
  return created.space.id;
}

function resolveApiUrl(): string {
  const env = process.env.ARKE_API_URL?.trim();
  if (env) return env;
  const stored = config.get("apiUrl");
  if (stored) return stored;
  return `http://localhost:${DEFAULT_API_PORT}`;
}
