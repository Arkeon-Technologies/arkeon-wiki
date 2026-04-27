// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";

import type { AppBindings } from "../types.js";
import { ApiError } from "../lib/errors.js";
import { search } from "../lib/search.js";

export const searchRouter = new Hono<AppBindings>();

// GET /search?q=...&space_id=...&limit=20&snippets=3&regex=false
//
// Filesystem keyword search via ripgrep. Returns ranked entity matches
// with line-level snippets. If `space_id` is omitted, searches every
// registered space.
searchRouter.get("/", async (c) => {
  const query = c.req.query("q");
  if (!query) {
    throw new ApiError(400, "validation_error", "q is required");
  }

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

  const result = await search({
    query,
    spaceId,
    limit,
    maxSnippetsPerFile,
    regex,
  });

  return c.json(result);
});
