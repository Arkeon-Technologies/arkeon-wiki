// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki init [name]` — register the current directory as a space.
 *
 * Creates a space in the running Arkeon instance. The daemon automatically
 * starts watching the directory and syncs all files.
 */

import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { DEFAULT_API_PORT } from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";
import { loadRepoState, type RepoState } from "../../lib/repo-state.js";

interface InitOptions {
  apiUrl?: string;
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .argument("[name]", "Space name (defaults to directory name)")
    .description("Register this directory as an Arkeon space")
    .option("--api-url <url>", "API URL (default: http://localhost:8000)")
    .action(async (name: string | undefined, options: InitOptions) => {
      try {
        await runInit(name, options);
      } catch (error) {
        output.error(error, { operation: "init" });
        process.exitCode = 1;
      }
    });
}

async function runInit(name: string | undefined, options: InitOptions): Promise<void> {
  const cwd = process.cwd();
  const spaceName = name ?? basename(cwd);
  const apiUrl = options.apiUrl ?? process.env.ARKE_API_URL ?? `http://localhost:${DEFAULT_API_PORT}`;

  // Check if already initialized
  const existing = loadRepoState();
  if (existing) {
    console.log(`This directory is already initialized (space: ${existing.space_name}).`);
    console.log(`Space ID: ${existing.space_id}`);
    return;
  }

  // Create space via API — the server will automatically start watching
  const res = await fetch(`${apiUrl}/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: spaceName, watch_dir: resolve(cwd) }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(
      `Failed to create space: ${res.status} ${(body as { error?: { message?: string } }).error?.message ?? res.statusText}`,
    );
  }

  const space = (await res.json()) as { id: string; name: string; watch_dir: string };

  // Write .arkeon/state.json
  const arkeonDir = join(cwd, ".arkeon");
  if (!existsSync(arkeonDir)) mkdirSync(arkeonDir, { recursive: true });

  const state: RepoState = {
    api_url: apiUrl,
    space_id: space.id,
    space_name: space.name,
    created_at: new Date().toISOString(),
  };
  writeFileSync(join(arkeonDir, "state.json"), JSON.stringify(state, null, 2));

  // Add .arkeon/ to .gitignore
  const gitignorePath = join(cwd, ".gitignore");
  if (existsSync(gitignorePath)) {
    const gitignoreContent = readFileSync(gitignorePath, "utf-8");
    if (!gitignoreContent.includes(".arkeon/")) {
      writeFileSync(gitignorePath, `${gitignoreContent.trimEnd()}\n.arkeon/\n`);
    }
  }

  // Create wiki/ directory
  const wikiDir = join(cwd, "wiki");
  if (!existsSync(wikiDir)) mkdirSync(wikiDir, { recursive: true });

  output.result({
    operation: "init",
    space_id: space.id,
    space_name: space.name,
    watch_dir: resolve(cwd),
    hint: "The daemon is now watching this directory. Any files you add will be synced automatically.",
  });
}
