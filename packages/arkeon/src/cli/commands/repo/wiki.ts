// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki wiki add <file...>` — sync wiki files to the knowledge graph.
 */

import type { Command } from "commander";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

import { output } from "../../lib/output.js";
import { loadRepoState } from "../../lib/repo-state.js";
import { DEFAULT_API_PORT } from "../../lib/local-runtime.js";

export function registerWikiCommands(program: Command): void {
  const wiki = program.command("wiki").description("Wiki operations");

  wiki
    .command("add")
    .argument("<files...>", "Wiki markdown files to sync")
    .description("Sync wiki files to the knowledge graph")
    .action(async (files: string[]) => {
      try {
        await runWikiAdd(files);
      } catch (error) {
        output.error(error, { operation: "wiki add" });
        process.exitCode = 1;
      }
    });
}

async function runWikiAdd(files: string[]): Promise<void> {
  const state = loadRepoState();
  if (!state) {
    throw new Error("Not initialized. Run `arkeon-wiki init` first.");
  }

  const apiUrl = state.api_url ?? `http://localhost:${DEFAULT_API_PORT}`;
  const cwd = process.cwd();

  // Resolve files to space-relative paths
  const relativePaths: string[] = [];
  for (const file of files) {
    const absPath = resolve(cwd, file);
    if (!existsSync(absPath)) {
      console.warn(`[arkeon-wiki] File not found: ${file}`);
      continue;
    }
    relativePaths.push(relative(cwd, absPath));
  }

  if (relativePaths.length === 0) {
    throw new Error("No valid files to sync.");
  }

  const res = await fetch(`${apiUrl}/spaces/${state.space_id}/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: relativePaths }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(
      `Sync failed: ${res.status} ${(body as { error?: { message?: string } }).error?.message ?? res.statusText}`,
    );
  }

  const body = (await res.json()) as {
    results: Array<{
      entityId: string;
      action: string;
      label: string;
      type: string;
      linksResolved: number;
      linksDangling: number;
    }>;
  };

  for (const result of body.results) {
    const linkInfo = result.linksResolved > 0 || result.linksDangling > 0
      ? ` (${result.linksResolved} links resolved, ${result.linksDangling} dangling)`
      : "";
    console.log(`  ${result.action}: ${result.label} [${result.entityId}]${linkInfo}`);
  }

  output.result({
    operation: "wiki add",
    results: body.results,
  });
}
