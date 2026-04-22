// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki file add <file...>` — register source files in the knowledge graph.
 */

import type { Command } from "commander";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

import { output } from "../../lib/output.js";
import { loadRepoState } from "../../lib/repo-state.js";
import { DEFAULT_API_PORT } from "../../lib/local-runtime.js";

export function registerFileCommands(program: Command): void {
  const file = program.command("file").description("Source file operations");

  file
    .command("add")
    .argument("<files...>", "Source files to register (supports globs)")
    .description("Register source files in the knowledge graph")
    .action(async (files: string[]) => {
      try {
        await runFileAdd(files);
      } catch (error) {
        output.error(error, { operation: "file add" });
        process.exitCode = 1;
      }
    });
}

async function runFileAdd(fileArgs: string[]): Promise<void> {
  const state = loadRepoState();
  if (!state) {
    throw new Error("Not initialized. Run `arkeon-wiki init` first.");
  }

  const apiUrl = state.api_url ?? `http://localhost:${DEFAULT_API_PORT}`;
  const cwd = process.cwd();

  // Resolve files to space-relative paths
  const relativePaths: string[] = [];
  for (const arg of fileArgs) {
    const absPath = resolve(cwd, arg);
    if (existsSync(absPath)) {
      relativePaths.push(relative(cwd, absPath));
    } else {
      console.warn(`[arkeon-wiki] File not found: ${arg}`);
    }
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
    results: Array<{ entityId: string; action: string; label: string; type: string }>;
  };

  for (const result of body.results) {
    console.log(`  ${result.action}: ${result.label} [${result.entityId}]`);
  }

  output.result({
    operation: "file add",
    results: body.results,
  });
}
