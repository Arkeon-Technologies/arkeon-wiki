// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 2 reader routes. Four URLs that let a human browse the writer's
 * HTML output:
 *
 *   GET /                     daemon landing — spaces list
 *   GET /:space               redirect to `/:space/` (relative-href hygiene)
 *   GET /:space/              alphabetical article index
 *   GET /:space/wiki/*        wiki article + chrome injection + link classes
 *   GET /:space/*             static-file fallback (sources, PDFs, images, ...)
 *
 * URL structure mirrors disk structure — articles linked as
 * `<a href="../sources/foo.md">` resolve to the same file under both
 * `file://` and `http://`. No path rewriting anywhere.
 *
 * The static-file fallback must be mounted AFTER `space-scoped.ts` (which
 * owns `/:space/entities`, `/:space/redlinks`, `/:space/recent`,
 * `/:space/search`, and `/:space/chat`). Hono's trie router prefers
 * static segments over parameterized ones, so registration order between
 * the two routers does not matter — but conceptually the reader is the
 * "everything else" layer.
 */

import { Hono } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

import type { AppBindings } from "../types.js";
import { ApiError } from "../lib/errors.js";
import { createSql } from "../lib/sql.js";
import { safeResolve } from "../lib/path.js";
import { shouldIgnorePath } from "../lib/fs-watcher.js";
import { loadSpacesMap } from "../lib/spaces.js";
import {
  instrumentArticle,
  renderArticleIndex,
  renderNotFound,
  renderSpaceIndex,
  type ArticleIndexRow,
  type SpaceIndexRow,
} from "../lib/reader.js";

export const readerRouter = new Hono<AppBindings>();

async function spaceWatchDir(spaceName: string): Promise<string | null> {
  const sql = createSql();
  const rows = await sql`SELECT watch_dir FROM spaces WHERE name = ${spaceName}`;
  if (rows.length === 0) return null;
  return rows[0].watch_dir as string;
}

async function knownPathsFor(spaceName: string): Promise<Set<string>> {
  const sql = createSql();
  const rows = await sql`
    SELECT source_path FROM entities WHERE space_name = ${spaceName}
  `;
  const out = new Set<string>();
  for (const row of rows) out.add(row.source_path as string);
  return out;
}

// ── GET / — daemon landing ────────────────────────────────────────

readerRouter.get("/", async (c) => {
  const sql = createSql();
  const rows = await sql`
    SELECT s.name,
           (SELECT COUNT(*) FROM entities e WHERE e.space_name = s.name) AS entity_count
    FROM spaces s
    ORDER BY s.name ASC
  `;
  const spaces: SpaceIndexRow[] = rows.map((r) => ({
    name: r.name as string,
    entity_count: Number(r.entity_count ?? 0),
  }));
  return c.html(renderSpaceIndex(spaces));
});

// ── GET /:space — redirect to /:space/ ────────────────────────────
//
// Relative hrefs in the article-index page resolve against the URL's
// directory, so the trailing slash is load-bearing. Redirecting up
// front keeps every link sane regardless of how the user typed the URL.

readerRouter.get("/:space", async (c) => {
  const space = c.req.param("space");
  return c.redirect(`/${encodeURIComponent(space)}/`, 301);
});

// ── GET /:space/ — article index ──────────────────────────────────

readerRouter.get("/:space/", async (c) => {
  const space = c.req.param("space");
  const watchDir = await spaceWatchDir(space);
  if (!watchDir) {
    throw new ApiError(404, "not_found", `Space '${space}' not found`);
  }

  const sql = createSql();
  const rows = await sql`
    SELECT source_path, label, properties
    FROM entities
    WHERE space_name = ${space} AND type = 'wiki'
    ORDER BY updated_at DESC, source_path ASC
  `;
  const articles: ArticleIndexRow[] = rows.map((r) => {
    let shortDescription: string | null = null;
    try {
      const propsRaw = r.properties;
      const props =
        typeof propsRaw === "string" ? JSON.parse(propsRaw || "{}") : (propsRaw ?? {});
      const v = (props as Record<string, unknown>).short_description;
      if (typeof v === "string" && v.length > 0) shortDescription = v;
    } catch {
      // Ignore malformed properties — fall back to no description.
    }
    return {
      source_path: r.source_path as string,
      label: (r.label as string | null) ?? null,
      short_description: shortDescription,
    };
  });

  return c.html(renderArticleIndex(space, articles));
});

// ── GET /:space/wiki/* — wiki article view ────────────────────────

readerRouter.get("/:space/wiki/*", async (c) => {
  const space = c.req.param("space");
  const watchDir = await spaceWatchDir(space);
  if (!watchDir) {
    throw new ApiError(404, "not_found", `Space '${space}' not found`);
  }

  const articlePath = extractSpacePath(c.req.url, space);
  if (!articlePath || !articlePath.startsWith("wiki/")) {
    throw new ApiError(400, "validation_error", "missing wiki path");
  }
  if (shouldIgnorePath(articlePath)) {
    return c.html(renderNotFound(space, articlePath), 404);
  }

  let abs: string;
  try {
    abs = safeResolve(watchDir, articlePath);
  } catch {
    return c.html(renderNotFound(space, articlePath), 404);
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return c.html(renderNotFound(space, articlePath), 404);
  }

  const original = readFileSync(abs, "utf-8");
  const knownPaths = await knownPathsFor(space);
  const spaces = await loadSpacesMap();
  const instrumented = instrumentArticle(original, articlePath, knownPaths, space, {
    watchDir,
    spaces,
  });
  return c.html(instrumented);
});

// ── GET /:space/* — static file fallback ──────────────────────────

readerRouter.get("/:space/*", async (c) => {
  const space = c.req.param("space");
  const watchDir = await spaceWatchDir(space);
  if (!watchDir) {
    throw new ApiError(404, "not_found", `Space '${space}' not found`);
  }

  const relPath = extractSpacePath(c.req.url, space);
  if (!relPath) {
    throw new ApiError(400, "validation_error", "missing file path");
  }
  // The reader never serves anything under hidden / ignored directories
  // (`.arkeon`, `.git`, `node_modules`, dot-prefixed files, …). Same set
  // the watcher refuses to index — see `shouldIgnorePath`.
  if (shouldIgnorePath(relPath)) {
    return c.html(renderNotFound(space, relPath), 404);
  }

  let abs: string;
  try {
    abs = safeResolve(watchDir, relPath);
  } catch {
    return c.html(renderNotFound(space, relPath), 404);
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return c.html(renderNotFound(space, relPath), 404);
  }

  const body = readFileSync(abs);
  const contentType = mimeTypeFor(abs);
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
});

// ── helpers ───────────────────────────────────────────────────────

/**
 * Pull the in-space path out of a `/{space}/...` URL. Hono's
 * `c.req.param("*")` returns the wildcard match, but the wiki route
 * captures it as `wiki/foo.html` (no leading slash) while the catch-all
 * captures everything after `/{space}/`. Going through the URL pathname
 * directly avoids the discrepancy and decodes percent-escapes uniformly.
 */
function extractSpacePath(rawUrl: string, space: string): string | null {
  const u = new URL(rawUrl);
  const prefix = `/${space}/`;
  const idx = u.pathname.indexOf(prefix);
  if (idx < 0) return null;
  const remainder = u.pathname.slice(idx + prefix.length);
  if (!remainder) return null;
  try {
    return decodeURIComponent(remainder);
  } catch {
    return null;
  }
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".yaml": "application/yaml; charset=utf-8",
  ".yml": "application/yaml; charset=utf-8",
  ".rst": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function mimeTypeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}
