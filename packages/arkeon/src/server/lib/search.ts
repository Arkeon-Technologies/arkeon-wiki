// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Filesystem keyword search via ripgrep.
 *
 * For each registered space, spawns ripgrep against the space's
 * watch_dir with --json output, parses the stream into per-file match
 * counts and snippets, then joins the results to entities by
 * source_path.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rgPath } from "@vscode/ripgrep";

import { createSql } from "./sql.js";
import type { EntityType } from "./entities.js";

const SNIPPET_MAX_LEN = 240;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const DEFAULT_SNIPPETS_PER_FILE = 3;
/** Maximum number of patterns accepted in a single multi-query call.
 *  Defensive cap so a runaway caller can't fan out a thousand-pattern
 *  search; the tool layer enforces the same limit at the Zod schema. */
export const MAX_QUERY_PATTERNS = 10;

export interface KeywordSearchOptions {
  /** Single substring/regex pattern, or up to MAX_QUERY_PATTERNS
   *  patterns run together as one ripgrep invocation (`-e p1 -e p2`).
   *  Match counts aggregate per file, so multi-pattern hits naturally
   *  rank higher — this is the right behaviour for variant batching
   *  ("Shannon", "Claude Shannon", "information theorist"). */
  query: string | string[];
  /** Single-space convenience filter. Equivalent to passing
   *  `spaceIds: [spaceId]`. If both are set, `spaceIds` wins. */
  spaceId?: string;
  /** Restrict the search to a specific set of registered spaces.
   *  Empty/undefined = every registered space. Used by the agent
   *  runtime to fan out across a role's allowed-space scope. */
  spaceIds?: string[];
  /** Restrict hits to entities of the given type(s). Any combination
   *  of `wiki`, `file`. Omit/empty = no filter. Ripgrep still scans
   *  every indexed file; the filter applies post-fetch on the
   *  entity-join rows so the `unmatched_files` diagnostic counter
   *  retains its "no entity at all" meaning instead of conflating
   *  with "filtered out by type". Useful for source-only sweeps
   *  (`['file']`) or wiki-only sweeps (`['wiki']`). Placeholder wikis
   *  (`type='wiki'` with `source_hash IS NULL`, post-#104) are not
   *  separable here — use `/entities?unresolved=true` if you want
   *  those filtered specifically. */
  types?: EntityType[];
  limit?: number;
  maxSnippetsPerFile?: number;
  regex?: boolean;
}

export interface SearchSnippet {
  line_number: number;
  text: string;
}

export interface KeywordSearchHit {
  entity_id: string;
  space_id: string;
  type: EntityType;
  label: string;
  source_path: string;
  match_count: number;
  snippets: SearchSnippet[];
}

export interface KeywordSearchResult {
  hits: KeywordSearchHit[];
  total: number;
  /** Files matched by ripgrep that had no entity mapping (e.g., excluded
   *  extensions) and were therefore skipped. Useful for diagnostics. */
  unmatched_files: number;
}

interface FileResult {
  path: string;
  match_count: number;
  snippets: SearchSnippet[];
}

/**
 * Parse newline-delimited ripgrep --json output into per-file results.
 *
 * ripgrep emits one JSON event per line. We care about `match` (one line
 * with submatches) and `end` (per-file stats). Other event types
 * (begin, summary, context) are ignored.
 *
 * Exported for unit testing.
 */
export function parseRipgrepJson(
  stdout: string,
  maxSnippetsPerFile: number,
): FileResult[] {
  const byPath = new Map<string, FileResult>();

  const ensure = (path: string): FileResult => {
    let entry = byPath.get(path);
    if (!entry) {
      entry = { path, match_count: 0, snippets: [] };
      byPath.set(path, entry);
    }
    return entry;
  };

  for (const line of stdout.split("\n")) {
    if (!line) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const ev = event as { type?: string; data?: Record<string, unknown> };

    if (ev.type === "match") {
      const path = readPath(ev.data);
      if (!path) continue;
      const lineText = readLineText(ev.data);
      const lineNumber = ev.data?.line_number;
      const entry = ensure(path);
      if (
        entry.snippets.length < maxSnippetsPerFile &&
        typeof lineText === "string" &&
        typeof lineNumber === "number"
      ) {
        entry.snippets.push({
          line_number: lineNumber,
          text: truncateSnippet(lineText.replace(/\n$/, "")),
        });
      }
    } else if (ev.type === "end") {
      const path = readPath(ev.data);
      if (!path) continue;
      const stats = ev.data?.stats as { matched_lines?: number } | undefined;
      const entry = ensure(path);
      if (typeof stats?.matched_lines === "number") {
        entry.match_count = stats.matched_lines;
      }
    }
  }

  return [...byPath.values()];
}

function readPath(data: Record<string, unknown> | undefined): string | null {
  const path = data?.path as { text?: string } | undefined;
  if (typeof path?.text !== "string") return null;
  // ripgrep emits "./file.md" or "file.md" depending on how we invoked it
  return path.text.replace(/^\.\//, "");
}

function readLineText(data: Record<string, unknown> | undefined): string | null {
  const lines = data?.lines as { text?: string } | undefined;
  return typeof lines?.text === "string" ? lines.text : null;
}

function truncateSnippet(text: string): string {
  if (text.length <= SNIPPET_MAX_LEN) return text;
  return text.slice(0, SNIPPET_MAX_LEN) + "…";
}

/**
 * Spawn ripgrep against `cwd` with one or more query patterns and return
 * parsed file results. Multiple patterns are passed as repeated `-e`
 * arguments — ripgrep ORs them in a single pass, so an entity that
 * matches several variants of a name accumulates a higher match count
 * naturally. Exit codes: 0 = matches found, 1 = no matches, 2+ = error.
 */
export function runRipgrep(opts: {
  cwd: string;
  queries: string[];
  regex: boolean;
  maxSnippetsPerFile: number;
}): Promise<FileResult[]> {
  return new Promise((resolve, reject) => {
    const args: string[] = ["--json", "--smart-case"];
    if (!opts.regex) args.push("--fixed-strings");
    // Exclude our own state dir. .git and node_modules are already skipped
    // by ripgrep's default gitignore behaviour, but we set them explicitly
    // so this works in directories without a .gitignore.
    args.push("--glob", "!.arkeon");
    args.push("--glob", "!.git");
    args.push("--glob", "!node_modules");
    // Restrict to the file types we index.
    args.push("--type-add", "arkeon:*.{md,txt,json,csv,xml,html,rst}");
    args.push("--type", "arkeon");
    for (const q of opts.queries) {
      args.push("-e", q);
    }
    args.push("--", ".");

    const child = spawn(rgPath, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf-8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === 1) {
        resolve(parseRipgrepJson(stdout, opts.maxSnippetsPerFile));
      } else {
        reject(new Error(`ripgrep exited ${code}: ${stderr.trim()}`));
      }
    });
  });
}

/**
 * Filesystem keyword search across one or all registered spaces.
 */
export async function searchKeyword(
  opts: KeywordSearchOptions,
): Promise<KeywordSearchResult> {
  // Normalise to a non-empty pattern array. Empty / oversized inputs
  // are caller bugs — surface them rather than silently swallowing the
  // call (e.g. a 0-pattern array would otherwise tell ripgrep to match
  // everything, which is almost certainly not what was meant).
  const queries = Array.isArray(opts.query) ? opts.query : [opts.query];
  if (queries.length === 0) {
    throw new Error("searchKeyword: query must not be empty");
  }
  if (queries.length > MAX_QUERY_PATTERNS) {
    throw new Error(
      `searchKeyword: too many query patterns (${queries.length}); max is ${MAX_QUERY_PATTERNS}`,
    );
  }
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const maxSnippets = Math.max(0, opts.maxSnippetsPerFile ?? DEFAULT_SNIPPETS_PER_FILE);
  const types = opts.types && opts.types.length > 0 ? opts.types : null;

  const sql = createSql();
  const requestedIds =
    opts.spaceIds && opts.spaceIds.length > 0
      ? opts.spaceIds
      : opts.spaceId
        ? [opts.spaceId]
        : null;

  const spaces = await (requestedIds
    ? sql.query(
        `SELECT id, watch_dir FROM spaces WHERE id IN (${requestedIds.map(() => "?").join(",")})`,
        requestedIds,
      )
    : sql`SELECT id, watch_dir FROM spaces`);

  if (spaces.length === 0) {
    return { hits: [], total: 0, unmatched_files: 0 };
  }

  let unmatched = 0;
  const hits: KeywordSearchHit[] = [];

  for (const space of spaces) {
    const watchDir = space.watch_dir as string | null;
    const spaceId = space.id as string;
    if (!watchDir) continue;
    // A registered space's directory can vanish out from under us (user
    // rm'd it, or removable media unmounted). spawn() with a missing cwd
    // surfaces as ENOENT on the rg path, which looks like a missing
    // binary — skip cleanly instead.
    if (!existsSync(watchDir)) continue;

    const fileResults = await runRipgrep({
      cwd: watchDir,
      queries,
      regex: !!opts.regex,
      maxSnippetsPerFile: maxSnippets,
    });

    if (fileResults.length === 0) continue;

    const paths = fileResults.map((r) => r.path);
    const placeholders = paths.map(() => "?").join(",");
    const entityRows = await sql.query(
      `SELECT id, space_id, type, label, source_path
       FROM entities
       WHERE space_id = ? AND source_path IN (${placeholders})`,
      [spaceId, ...paths],
    );
    const entityByPath = new Map<string, Record<string, unknown>>();
    for (const e of entityRows) entityByPath.set(e.source_path as string, e);

    for (const fileResult of fileResults) {
      const entity = entityByPath.get(fileResult.path);
      if (!entity) {
        unmatched++;
        continue;
      }
      // Type filter: drop entities whose type isn't in the allowed set.
      // We filter post-fetch (instead of pushing into SQL) so the
      // `unmatched_files` diagnostic keeps its meaning — files filtered
      // out by `types` are not "unmatched", they're explicitly excluded.
      if (types && !types.includes(entity.type as EntityType)) {
        continue;
      }
      hits.push({
        entity_id: entity.id as string,
        space_id: entity.space_id as string,
        type: entity.type as EntityType,
        label: entity.label as string,
        source_path: entity.source_path as string,
        match_count: fileResult.match_count,
        snippets: fileResult.snippets,
      });
    }
  }

  // Rank by match count desc, tiebreak by entity_id for determinism.
  hits.sort(
    (a, b) =>
      b.match_count - a.match_count || a.entity_id.localeCompare(b.entity_id),
  );

  const limited = hits.slice(0, limit);
  return {
    hits: limited,
    total: limited.length,
    unmatched_files: unmatched,
  };
}
