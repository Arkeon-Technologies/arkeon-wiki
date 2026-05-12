// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon-wiki search <query>` — keyword search via the daemon's
 * GET /{space}/search route.
 *
 * Defaults to the space bound to the current directory (via
 * .arkeon/state.json); pass `--space <name>` to target another space.
 * `--all` is removed: post-Phase-1 search is per-space (the route
 * doesn't have a daemon-wide form).
 */

import type { Command } from "commander";

import { DEFAULT_API_PORT } from "../../lib/local-runtime.js";
import { output } from "../../lib/output.js";
import { loadRepoState } from "../../lib/repo-state.js";

interface SearchOptions {
  space?: string;
  limit?: string;
  snippets?: string;
  regex?: boolean;
}

interface KeywordHit {
  space_name: string;
  source_path: string;
  type: string;
  label: string | null;
  match_count: number;
  snippets: { line_number: number; text: string }[];
}

interface SearchResponse {
  query: string | string[];
  keyword: { hits: KeywordHit[]; total: number; unmatched_files: number };
}

export function registerSearchCommand(program: Command): void {
  program
    .command("search")
    .argument("<query>", "Search query")
    .description("Keyword search (ripgrep) within a registered space")
    .option("--space <name>", "Space name to search (default: bound space)")
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
  const apiUrl =
    process.env.ARKE_API_URL ??
    repoState?.api_url ??
    `http://localhost:${DEFAULT_API_PORT}`;

  const space = options.space ?? repoState?.space_name;
  if (!space) {
    throw new Error(
      "search: --space is required when not run inside an arkeon-wiki space (no .arkeon/state.json found).",
    );
  }

  const params = new URLSearchParams({ q: query });
  if (options.limit) params.set("limit", options.limit);
  if (options.snippets) params.set("snippets", options.snippets);
  if (options.regex) params.set("regex", "true");

  const res = await fetch(`${apiUrl}/${encodeURIComponent(space)}/search?${params.toString()}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const message =
      (body as { error?: { message?: string } }).error?.message ?? res.statusText;
    throw new Error(`Search failed: ${res.status} ${message}`);
  }

  const result = (await res.json()) as SearchResponse;
  output.result({
    operation: "search",
    space,
    query: result.query,
    keyword: result.keyword,
  });
}
