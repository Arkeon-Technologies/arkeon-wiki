// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Directory-browser reader.
 *
 *   GET /             → directory listing of the watched root
 *   GET /<path>/      → directory listing
 *   GET /<path>       → file serve (HTML files run through wikilink rewrite)
 *
 * The reader is the catch-all; mount it last so explicit API routes
 * (/query, /tag, /tags, …) win.
 */

import { Hono, type Context } from "hono";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

import type { AppBindings } from "../types.js";
import { ApiError } from "../lib/errors.js";
import { createSql } from "../lib/sql.js";
import { safeResolve } from "../lib/path.js";
import { getWatchedRoot, shouldIgnorePath } from "../lib/fs-watcher.js";
import { parseHtmlMeta } from "../lib/html-meta.js";
import {
  renderDirectoryListing,
  renderNotFound,
  rewriteWikilinks,
  type DirEntry,
} from "../lib/reader.js";

export const readerRouter = new Hono<AppBindings>();

function decodePath(rawUrl: string): string {
  const u = new URL(rawUrl);
  // Strip leading slash; decode percent-escapes.
  let p = u.pathname.replace(/^\//, "");
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep raw */
  }
  return p;
}

readerRouter.get("/*", async (c) => {
  const root = getWatchedRoot();
  if (!root) throw new ApiError(503, "not_ready", "watcher not started");

  const relPath = decodePath(c.req.url);

  // Directory or file?
  if (relPath === "" || relPath.endsWith("/")) {
    return serveDirectory(c, root, relPath.replace(/\/$/, ""));
  }

  // Forbid hidden / ignored paths.
  if (shouldIgnorePath(relPath)) {
    return c.html(renderNotFound(relPath), 404);
  }

  let abs: string;
  try {
    abs = safeResolve(root, relPath);
  } catch {
    return c.html(renderNotFound(relPath), 404);
  }
  if (!existsSync(abs)) return c.html(renderNotFound(relPath), 404);

  const stat = statSync(abs);
  if (stat.isDirectory()) {
    // Browsers usually trailing-slash directory URLs, but treat
    // /<dir> as a directory listing too.
    return serveDirectory(c, root, relPath);
  }

  const ext = extname(relPath).toLowerCase();
  if (ext === ".html" || ext === ".htm") {
    const sql = createSql();
    const rows = await sql`SELECT path FROM artifacts`;
    const knownPaths = new Set<string>();
    for (const row of rows) knownPaths.add(row.path as string);
    const original = readFileSync(abs, "utf-8");
    return c.html(rewriteWikilinks(original, relPath, knownPaths));
  }

  const body = readFileSync(abs);
  return new Response(body, {
    status: 200,
    headers: { "content-type": mimeTypeFor(abs) },
  });
});

async function serveDirectory(
  c: Context<AppBindings>,
  root: string,
  relPath: string,
): Promise<Response> {
  const abs = relPath === "" ? root : safeResolve(root, relPath);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    return c.html(renderNotFound(relPath), 404);
  }
  const entries: DirEntry[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      entries.push({ name: entry.name, is_dir: true, short_description: null });
    } else if (entry.isFile()) {
      let short: string | null = null;
      const ext = extname(entry.name).toLowerCase();
      if (ext === ".html" || ext === ".htm") {
        try {
          const html = readFileSync(safeResolve(abs, entry.name), "utf-8");
          const meta = parseHtmlMeta(html);
          const desc = meta.properties.short_description;
          if (typeof desc === "string" && desc.length > 0) short = desc;
        } catch {
          /* ignore */
        }
      }
      entries.push({ name: entry.name, is_dir: false, short_description: short });
    }
  }
  entries.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return c.html(renderDirectoryListing(relPath, entries));
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
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}
