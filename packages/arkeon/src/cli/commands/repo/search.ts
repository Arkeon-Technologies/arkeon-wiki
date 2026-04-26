// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki search <query>` — keyword search across registered spaces.
 *
 * Calls `GET /search` on the running daemon. By default scopes to the
 * space bound to the current directory (via `.arkeon/state.json`); pass
 * `--all` to search every registered space, or `--space <id>` for a
 * specific one.
 */

import type { Command } from "commander";

import { DEFAULT_API_PORT } from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";
import { loadRepoState } from "../../lib/repo-state.js";

interface SearchOptions {
  apiUrl?: string;
  space?: string;
  all?: boolean;
  limit?: string;
  snippets?: string;
  regex?: boolean;
}

export function registerSearchCommand(program: Command): void {
  program
    .command("search")
    .argument("<query>", "Search query (literal substring by default)")
    .description("Keyword search across registered spaces (via ripgrep)")
    .option("--api-url <url>", "API URL (default: http://localhost:8000)")
    .option("--space <id>", "Space ID to search (default: bound space, or all)")
    .option("--all", "Search every registered space")
    .option("--limit <n>", "Max results to return (default 20, max 200)")
    .option("--snippets <n>", "Max snippets per result (default 3)")
    .option("--regex", "Treat query as a regular expression")
    .action(async (query: string, options: SearchOptions) => {
      try {
        await runSearch(query, options);
      } catch (error) {
        output.error(error, { operation: "search" });
        process.exitCode = 1;
      }
    });
}

async function runSearch(query: string, options: SearchOptions): Promise<void> {
  const repoState = loadRepoState();
  const apiUrl =
    options.apiUrl ??
    repoState?.api_url ??
    process.env.ARKE_API_URL ??
    `http://localhost:${DEFAULT_API_PORT}`;

  const params = new URLSearchParams({ q: query });
  if (!options.all) {
    const spaceId = options.space ?? repoState?.space_id;
    if (spaceId) params.set("space_id", spaceId);
  }
  if (options.limit) params.set("limit", options.limit);
  if (options.snippets) params.set("snippets", options.snippets);
  if (options.regex) params.set("regex", "true");

  const res = await fetch(`${apiUrl}/search?${params.toString()}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const message =
      (body as { error?: { message?: string } }).error?.message ?? res.statusText;
    throw new Error(`Search failed: ${res.status} ${message}`);
  }

  const result = (await res.json()) as {
    query: string;
    hits: Array<{
      entity_id: string;
      space_id: string;
      type: string;
      label: string;
      source_path: string;
      match_count: number;
      snippets: { line_number: number; text: string }[];
    }>;
    unmatched_files: number;
  };

  output.result({
    operation: "search",
    query: result.query,
    hit_count: result.hits.length,
    unmatched_files: result.unmatched_files,
    hits: result.hits,
  });
}
