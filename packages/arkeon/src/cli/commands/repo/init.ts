// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki init [name]` — register the current directory as a space.
 *
 * Creates a space in the running Arkeon instance with watch_dir pointing
 * to the current directory. Writes .arkeon/state.json with the space ID.
 * Triggers an initial sync of all eligible files.
 */

import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
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

  // Create space via API
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

  // Add .arkeon/ to .gitignore if it exists
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

  // Trigger initial sync of existing files
  const files = walkFiles(cwd);
  if (files.length > 0) {
    console.log(`[arkeon-wiki] Syncing ${files.length} files...`);
    const syncRes = await fetch(`${apiUrl}/spaces/${space.id}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files }),
    });
    if (syncRes.ok) {
      const body = (await syncRes.json()) as { results: Array<{ action: string }> };
      const created = body.results.filter((r) => r.action === "created").length;
      const updated = body.results.filter((r) => r.action === "updated").length;
      console.log(`[arkeon-wiki] Synced: ${created} created, ${updated} updated`);
    }
  }

  output.result({
    operation: "init",
    space_id: space.id,
    space_name: space.name,
    watch_dir: resolve(cwd),
    files_synced: files.length,
  });
}

// Dirs to skip when walking
const IGNORE_DIRS = new Set([".arkeon", ".git", "node_modules", ".claude", "__pycache__", ".venv"]);

// File extensions to index
const INDEX_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv", ".xml", ".html", ".rst"]);

function walkFiles(root: string, prefix = ""): string[] {
  const results: string[] = [];

  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;

    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      results.push(...walkFiles(root, relativePath));
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
      if (INDEX_EXTENSIONS.has(ext)) {
        results.push(relativePath);
      }
    }
  }

  return results;
}
