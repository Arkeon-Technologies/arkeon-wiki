// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";

import type { AppBindings } from "../types.js";
import { ApiError } from "../lib/errors.js";
import { parseEntityTypes } from "../lib/entities.js";
import {
  MAX_QUERY_PATTERNS,
  searchKeyword,
  type KeywordSearchResult,
} from "../lib/search.js";

export const searchRouter = new Hono<AppBindings>();

interface SearchResponse {
  /** Echoes the requested query/queries — single string when one `q`
   *  was passed, array when several were OR'd together. */
  query: string | string[];
  keyword: KeywordSearchResult;
}

// GET /search?q=...&space_id=...&type=...&limit=20&snippets=3&regex=false
//
// Keyword-only search backed by ripgrep. Results are entity-level,
// ranked by ripgrep match_count, with line-snippet evidence.
//
// `space_id` filters results. `type` is a comma-separated list of
// entity types to keep — any of `wiki`, `file`. Omit for no filter.
// Placeholder wikis (no file on disk yet) are `type='wiki'`; filter
// them via `/entities?unresolved=true`.
//
// `q` may be repeated (`?q=foo&q=bar`) up to MAX_QUERY_PATTERNS times
// to OR several patterns in one ripgrep pass. All patterns share
// ripgrep's --smart-case semantics — a single uppercase letter in any
// `q` makes the whole batch case-sensitive.
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
  const queryEcho = queries.length === 1 ? queries[0]! : queries;

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

  const keyword = await searchKeyword({
    query: queryForKeyword,
    spaceId,
    types,
    limit,
    maxSnippetsPerFile,
    regex,
  });

  const response: SearchResponse = { query: queryEcho, keyword };
  return c.json(response);
});
