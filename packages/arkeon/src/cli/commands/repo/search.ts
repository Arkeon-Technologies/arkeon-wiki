// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki search <query>` — keyword search across registered
 * spaces via the running daemon's GET /search route.
 *
 * By default scopes to the space bound to the current directory (via
 * `.arkeon/state.json`); pass `--all` to search every registered space,
 * or `--space <id>` for a specific one.
 */

import type { Command } from "commander";

import { DEFAULT_API_PORT } from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";
import { loadRepoState } from "../../lib/repo-state.js";

interface SearchOptions {
  space?: string;
  all?: boolean;
  limit?: string;
  snippets?: string;
  regex?: boolean;
}

interface KeywordHit {
  entity_id: string;
  space_id: string;
  type: string;
  label: string;
  source_path: string;
  match_count: number;
  snippets: { line_number: number; text: string }[];
}

interface SearchResponse {
  query: string;
  keyword: { hits: KeywordHit[]; total: number; unmatched_files: number };
}

export function registerSearchCommand(program: Command): void {
  program
    .command("search")
    .argument("<query>", "Search query")
    .description("Keyword search (ripgrep) across registered spaces")
    // --api-url is declared on the root program (src/index.ts); the
    // preAction hook moves the value into ARKE_API_URL. Declaring it
    // here too created a precedence bug where Commander routed the
    // value to globals but runSearch read subcommand-local opts.
    .option("--space <id>", "Space ID to search (default: bound space, or all)")
    .option("--all", "Search every registered space")
    .option("--limit <n>", "Max results (default 20, max 200)")
    .option("--snippets <n>", "Max line snippets per hit (default 3)")
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
  // Explicit override (--api-url, captured by the root preAction hook
  // into ARKE_API_URL) wins over the bound state file. Otherwise the
  // user couldn't override the bound URL without deleting state.json.
  const apiUrl =
    process.env.ARKE_API_URL ??
    repoState?.api_url ??
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

  const result = (await res.json()) as SearchResponse;

  output.result({
    operation: "search",
    query: result.query,
    keyword: result.keyword,
  });
}
