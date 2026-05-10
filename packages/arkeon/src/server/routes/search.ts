// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";

import type { AppBindings } from "../types.js";
import { ApiError } from "../lib/errors.js";
import { parseEntityTypes } from "../lib/entities.js";
import {
  MAX_QUERY_PATTERNS,
  searchKeyword,
  searchVector,
  type KeywordSearchResult,
  type VectorSearchResult,
} from "../lib/search.js";

export const searchRouter = new Hono<AppBindings>();

type Mode = "keyword" | "vector" | "both";

interface SearchResponse {
  /** Echoes the requested query/queries — single string when one `q`
   *  was passed, array when several were OR'd together. */
  query: string | string[];
  mode: Mode;
  keyword?: KeywordSearchResult;
  /** Vector results carry an extra `query_used` because vector mode
   *  always embeds a single string — when `q` is repeated only the
   *  first one drives the embedding. Surfacing it next to the hits
   *  makes the asymmetry explicit. */
  vector?: VectorSearchResult & { query_used: string };
}

// GET /search?q=...&mode=keyword|vector|both&space_id=...&type=...&limit=20&snippets=3&regex=false
//
// Issue #47, extended in #100. Two strategies, no fusion. Each mode's
// results are returned in their own namespace. Caller decides how (or
// whether) to combine.
//
//   mode=keyword           {keyword: {hits, total, unmatched_files}}
//   mode=vector            {vector: {hits, total, model, query_used}}
//   mode=both (default)    {keyword: ..., vector: ...}
//
// `keyword` hits are entity-level, ranked by ripgrep match_count, with
// line-snippet evidence. `vector` hits are also entity-level (one row
// per wiki, deduped from chunk-level KNN), sorted by cosine similarity,
// with the wiki's full body and frontmatter inlined.
//
// `space_id` filters both strategies. `limit` is per-strategy — each
// gets up to `limit` results. `snippets` and `regex` only affect keyword.
//
// `q` may be repeated (`?q=foo&q=bar`) up to MAX_QUERY_PATTERNS times
// to OR several patterns in one ripgrep pass. Vector mode embeds only
// the first `q` and surfaces it on `vector.query_used`. All patterns
// share ripgrep's --smart-case semantics — a single uppercase letter
// in any `q` makes the whole batch case-sensitive.
//
// `type` is a comma-separated list of entity types to keep in keyword
// hits — any of `wiki`, `file`, `stub`. Omit for no filter. Vector
// hits are always wikis.
searchRouter.get("/", async (c) => {
  const queries = c.req.queries("q");
  if (!queries || queries.length === 0) {
    throw new ApiError(400, "validation_error", "q is required");
  }
  if (queries.length > MAX_QUERY_PATTERNS) {
    throw new ApiError(
      400,
      "validation_error",
      `too many q parameters (${queries.length}); max is ${MAX_QUERY_PATTERNS}`,
    );
  }
  // Single-q calls keep their classic shape (`query: "foo"`); only
  // collapse to an array when the caller actually passed several.
  const queryForKeyword = queries.length === 1 ? queries[0]! : queries;
  const queryForVector = queries[0]!;
  const queryEcho = queries.length === 1 ? queries[0]! : queries;

  const modeParam = c.req.query("mode") ?? "both";
  if (modeParam !== "keyword" && modeParam !== "vector" && modeParam !== "both") {
    throw new ApiError(
      400,
      "validation_error",
      "mode must be 'keyword', 'vector', or 'both'",
    );
  }
  const mode: Mode = modeParam;

  // parseEntityTypes throws ApiError on invalid values; let it bubble.
  const types = parseEntityTypes(c.req.query("type"));

  const spaceId = c.req.query("space_id");
  const limitParam = c.req.query("limit");
  const snippetsParam = c.req.query("snippets");
  const regex = c.req.query("regex") === "true";

  const limit = limitParam ? Number(limitParam) : undefined;
  const maxSnippetsPerFile = snippetsParam ? Number(snippetsParam) : undefined;

  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    throw new ApiError(400, "validation_error", "limit must be a positive integer");
  }
  if (maxSnippetsPerFile !== undefined && (!Number.isFinite(maxSnippetsPerFile) || maxSnippetsPerFile < 0)) {
    throw new ApiError(400, "validation_error", "snippets must be >= 0");
  }

  const wantKeyword = mode === "keyword" || mode === "both";
  const wantVector = mode === "vector" || mode === "both";

  // Run requested strategies in parallel. Each is independently fail-soft:
  // if one throws (e.g. the embedder isn't available), the other still
  // returns. We surface the failure as an empty result for that strategy
  // rather than 500'ing the whole request — the caller can see which
  // strategies actually contributed via the presence of the keys.
  const [keywordSettled, vectorSettled] = await Promise.allSettled([
    wantKeyword
      ? searchKeyword({
          query: queryForKeyword,
          spaceId,
          types,
          limit,
          maxSnippetsPerFile,
          regex,
        })
      : Promise.resolve(null),
    wantVector
      ? searchVector({ query: queryForVector, spaceId, limit })
      : Promise.resolve(null),
  ]);

  const response: SearchResponse = { query: queryEcho, mode };

  if (wantKeyword) {
    if (keywordSettled.status === "fulfilled" && keywordSettled.value) {
      response.keyword = keywordSettled.value;
    } else if (keywordSettled.status === "rejected") {
      console.error(`[search] keyword strategy failed: ${keywordSettled.reason}`);
      response.keyword = { hits: [], total: 0, unmatched_files: 0 };
    }
  }

  if (wantVector) {
    if (vectorSettled.status === "fulfilled" && vectorSettled.value) {
      response.vector = { ...vectorSettled.value, query_used: queryForVector };
    } else if (vectorSettled.status === "rejected") {
      console.error(`[search] vector strategy failed: ${vectorSettled.reason}`);
      response.vector = {
        hits: [],
        total: 0,
        model: "unavailable",
        query_used: queryForVector,
      };
    }
  }

  return c.json(response);
});
