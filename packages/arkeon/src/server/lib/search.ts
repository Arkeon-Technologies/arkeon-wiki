// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Search strategies for the /search endpoint (issue #47).
 *
 * Two independent backends:
 *
 *   - searchKeyword(): filesystem keyword search via ripgrep. For each
 *     registered space, spawns ripgrep against the space's watch_dir
 *     with --json output, parses the stream into per-file match counts
 *     and snippets, then joins the results to entities by source_path.
 *
 *   - searchVector(): semantic search via sqlite-vec. Embeds the query
 *     once, KNN against chunk_vectors, joins to entity_chunks + entities.
 *     Returns chunk-level hits with cosine similarity scores.
 *
 * No fusion. The /search route runs whichever strategies the caller
 * asked for in parallel and dumps the results in a namespaced response.
 * Caller (UI / LLM) decides how to combine.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rgPath } from "@vscode/ripgrep";

import { createSql } from "./sql.js";
import { getEmbedder } from "./embedder/index.js";
import { parseFrontmatter } from "./frontmatter.js";

const SNIPPET_MAX_LEN = 240;
const DEFAULT_LIMIT = 20;
const VECTOR_DEFAULT_LIMIT = 8;
const MAX_LIMIT = 200;
const DEFAULT_SNIPPETS_PER_FILE = 3;

export interface KeywordSearchOptions {
  query: string;
  spaceId?: string;
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
  type: string;
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

export interface VectorSearchOptions {
  query: string;
  spaceId?: string;
  limit?: number;
}

/**
 * One vector search result. Wiki-level: each hit is a complete wiki,
 * not a chunk. Chunk-level KNN runs underneath but we collapse multiple
 * matches against the same wiki into a single hit (taking the best
 * similarity), then read the wiki's body and frontmatter from disk.
 *
 * Consumers (LLM agents, the explorer) get exactly what they want from
 * a "find related wikis" call: the wikis. No chunk_ids, no heading
 * paths, no chunk text fragments — those are how we *rank*, not what
 * the caller is asking for.
 */
export interface VectorSearchHit {
  entity_id: string;
  space_id: string;
  label: string;
  /** Path of the wiki file relative to the space's watch_dir. */
  source_path: string;
  /** 1 - cosine_distance of the wiki's best-matching chunk. Higher is
   *  more similar. Range: ~[-1, 1]. */
  similarity: number;
  /** Parsed YAML frontmatter (subject_type, label, aliases, etc.). */
  frontmatter: Record<string, unknown>;
  /** The wiki's full body markdown — everything after the frontmatter
   *  fences. Read from disk at query time so it's always current with
   *  whatever the file watcher last reconciled. */
  body: string;
}

export interface VectorSearchResult {
  hits: VectorSearchHit[];
  total: number;
  /** Identifier of the embedder model that produced the query vector,
   *  e.g. "mock@256" or "ollama:embeddinggemma:300m@256". Lets clients
   *  see what kind of semantic search they actually got — important for
   *  the mock-fallback case where the pipeline ran but the results are
   *  not semantically meaningful. */
  model: string;
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
 * Spawn ripgrep against `cwd` with the given query and return parsed file
 * results. Exit codes: 0 = matches found, 1 = no matches, 2+ = error.
 */
export function runRipgrep(opts: {
  cwd: string;
  query: string;
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
    args.push("--", opts.query, ".");

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
  const query = opts.query;
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const maxSnippets = Math.max(0, opts.maxSnippetsPerFile ?? DEFAULT_SNIPPETS_PER_FILE);

  const sql = createSql();
  const spaces = await (opts.spaceId
    ? sql`SELECT id, watch_dir FROM spaces WHERE id = ${opts.spaceId}`
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
      query,
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
      hits.push({
        entity_id: entity.id as string,
        space_id: entity.space_id as string,
        type: entity.type as string,
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

/**
 * Semantic search via sqlite-vec. Embeds the query, runs KNN over
 * chunk_vectors, joins back to entities, and collapses chunk hits to
 * one row per wiki — taking the wiki's best chunk similarity as its
 * score and reading the wiki's body + frontmatter from disk.
 *
 * The chunker exists so we can rank by topical-section similarity
 * instead of forcing the model to embed whole wikis at once. From the
 * caller's perspective, that's an implementation detail. What you ask
 * for ("find wikis related to X") is what you get back: a ranked list
 * of wikis, each with its full body.
 *
 * `space_id`, when present, filters joined entity rows. The KNN
 * happens across all chunks first because vec0's MATCH operator can't
 * be combined with a join-table filter inside its query plan; the
 * post-join WHERE then drops cross-space hits.
 *
 * Returns an empty result if no embeddings exist yet, the embedder
 * fails, the space has no chunks, or every matched chunk's wiki file
 * is missing from disk (a stale-index condition). The route layer is
 * responsible for deciding whether that's a 200 with [] or some other
 * behaviour.
 */
export async function searchVector(
  opts: VectorSearchOptions,
): Promise<VectorSearchResult> {
  const limit = Math.min(opts.limit ?? VECTOR_DEFAULT_LIMIT, MAX_LIMIT);

  const embedder = await getEmbedder();

  // If the model isn't loaded yet (e.g. cold start, weights still
  // downloading), short-circuit with a "warming" marker so the user's
  // query doesn't block on a 309 MB download. The caller can poll or
  // re-issue the search once vector.model stops being "warming".
  const state = embedder.state();
  if (state === "warming") {
    return { hits: [], total: 0, model: "warming" };
  }
  if (state === "failed") {
    return { hits: [], total: 0, model: "unavailable" };
  }

  const [vec] = await embedder.embed([opts.query], "query");
  const vecBuf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);

  const sql = createSql();

  // vec0 KNN. The k value has to live inside the WHERE as
  // `cv.k = <int>`; we ask for many more chunks than wikis we want
  // because (a) post-join space filtering may discard some and (b)
  // multiple chunks per wiki collapse to a single hit. With the
  // current chunker that's typically 1 card + 2-5 sections per wiki,
  // so 10× the wiki limit gives plenty of headroom.
  const k = Math.min(Math.max(limit * 10, 20), MAX_LIMIT);
  if (!Number.isInteger(k) || k < 1) {
    return { hits: [], total: 0, model: embedder.modelId };
  }

  // We don't LIMIT here — we collapse chunks → wikis client-side and
  // slice to `limit` after. SQL-side dedup via window functions would
  // require wrapping the vec0 MATCH, which vec0 doesn't compose well
  // with. The chunk row count is bounded by `k` already.
  const baseSql = `
    SELECT
      cv.distance AS distance,
      ec.entity_id AS entity_id,
      e.space_id AS space_id,
      e.label AS label,
      e.source_path AS source_path,
      sp.watch_dir AS watch_dir
    FROM chunk_vectors cv
    JOIN entity_chunks ec ON ec.id = cv.chunk_id
    JOIN entities e ON e.id = ec.entity_id
    JOIN spaces sp ON sp.id = e.space_id
    WHERE cv.embedding MATCH ?
      AND cv.k = ${k}
      ${opts.spaceId ? "AND e.space_id = ?" : ""}
    ORDER BY cv.distance
  `;

  const params = opts.spaceId ? [vecBuf, opts.spaceId] : [vecBuf];
  const rows = await sql.query(baseSql, params);

  // Collapse chunk hits → wiki hits. Rows are already in rank order
  // (distance ascending = similarity descending), so the first row
  // for an entity is its best match.
  const seen = new Set<string>();
  const hits: VectorSearchHit[] = [];
  for (const r of rows) {
    if (hits.length >= limit) break;
    const entityId = r.entity_id as string;
    if (seen.has(entityId)) continue;
    seen.add(entityId);

    const sourcePath = r.source_path as string;
    const watchDir = r.watch_dir as string | null;
    if (!watchDir) continue; // space row vanished mid-query
    const absPath = join(watchDir, sourcePath);
    if (!existsSync(absPath)) continue; // stale index entry; skip silently
    let frontmatter: Record<string, unknown>;
    let body: string;
    try {
      const raw = readFileSync(absPath, "utf-8");
      const parsed = parseFrontmatter(raw);
      frontmatter = parsed.properties;
      body = parsed.body;
    } catch {
      continue; // unreadable; skip rather than failing the whole search
    }

    hits.push({
      entity_id: entityId,
      space_id: r.space_id as string,
      label: r.label as string,
      source_path: sourcePath,
      similarity: 1 - (r.distance as number),
      frontmatter,
      body,
    });
  }

  return {
    hits,
    total: hits.length,
    model: embedder.modelId,
  };
}
