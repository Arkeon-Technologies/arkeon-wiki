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
 *
 * I/O posture: every filesystem touch goes through `node:fs/promises`
 * so the event loop keeps moving for concurrent API requests during
 * a long file read. Binary serves stream via `createReadStream` →
 * `Readable.toWeb` so a 50 MB embedded PDF doesn't buffer fully into
 * memory before flushing.
 */

import { Hono, type Context } from "hono";
import { createReadStream, type Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { extname, join } from "node:path";

import type { AppBindings } from "../types.js";
import { ApiError } from "../lib/errors.js";
import { createSql } from "../lib/sql.js";
import { safeResolve } from "../lib/path.js";
import { getWatchedRoot, shouldIgnorePath } from "../lib/fs-watcher.js";
import {
  renderDirectoryListing,
  renderNotFound,
  rewriteWikilinks,
  type DirEntry,
  type ListingPage,
  type ListingSort,
} from "../lib/reader.js";

export const readerRouter = new Hono<AppBindings>();

const DEFAULT_LISTING_LIMIT = 200;
const MAX_LISTING_LIMIT = 2000;
const VALID_SORTS: ListingSort[] = ["name", "mtime", "size"];

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

  let st: Stats;
  try {
    st = await stat(abs);
  } catch {
    return c.html(renderNotFound(relPath), 404);
  }
  if (st.isDirectory()) {
    // Browsers usually trailing-slash directory URLs, but treat
    // /<dir> as a directory listing too.
    return serveDirectory(c, root, relPath);
  }

  // Weak ETag from mtime + size. Edits on disk invalidate naturally
  // because syncFile writes go through atomic rename, which bumps
  // mtime even when the content hash is identical.
  const etag = buildEtag(st);
  const ifNoneMatch = c.req.header("if-none-match");
  if (ifNoneMatch && etagMatches(etag, ifNoneMatch)) {
    return new Response(null, { status: 304, headers: cacheHeaders(etag) });
  }

  const ext = extname(relPath).toLowerCase();
  if (ext === ".html" || ext === ".htm") {
    // HTML still buffers — wikilink rewriting needs the full document
    // and HTML sidecars are bounded by sane corpus sizes (KB to a few
    // MB). The streaming win is on raw binaries.
    const sql = createSql();
    const rows = await sql`SELECT path FROM artifacts`;
    const knownPaths = new Set<string>();
    for (const row of rows) knownPaths.add(row.path as string);
    const original = await readFile(abs, "utf-8");
    const html = rewriteWikilinks(original, relPath, knownPaths);
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...cacheHeaders(etag),
      },
    });
  }

  // Binary serve: stream off disk so a 50 MB PDF isn't buffered in
  // full before the first byte ships. `Readable.toWeb` is the
  // node-stream → web-stream adapter Hono / `new Response(...)`
  // consume directly.
  const stream = createReadStream(abs);
  const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
  return new Response(webStream, {
    status: 200,
    headers: {
      "content-type": mimeTypeFor(abs),
      "content-length": String(st.size),
      ...cacheHeaders(etag),
    },
  });
});

async function serveDirectory(
  c: Context<AppBindings>,
  root: string,
  relPath: string,
): Promise<Response> {
  const abs = relPath === "" ? root : safeResolve(root, relPath);
  let st: Stats;
  try {
    st = await stat(abs);
  } catch {
    return c.html(renderNotFound(relPath), 404);
  }
  if (!st.isDirectory()) {
    return c.html(renderNotFound(relPath), 404);
  }

  const limit = parseLimit(c.req.query("limit"));
  const offset = parseOffset(c.req.query("offset"));
  const sort = parseSort(c.req.query("sort"));

  // Pull labels + short_description for every immediate child of this
  // directory in one query, so we don't re-read each HTML file from
  // disk (would be 3k+ syscalls on a Substack-sized corpus). Sync
  // already parses <title> and <meta> into artifact.label /
  // properties — re-reading would just duplicate that work.
  const childIndex = await loadChildIndex(relPath);

  const dirents = (await readdir(abs, { withFileTypes: true })).filter(
    (d) => !d.name.startsWith("."),
  );

  // For mtime / size sorts we need a stat per entry. Name sort skips
  // the syscall entirely so the cheap path stays cheap.
  let entries: SortableEntry[];
  if (sort === "name") {
    entries = dirents.map((d) => ({
      name: d.name,
      is_dir: d.isDirectory(),
      mtime_ms: 0,
      size: 0,
    }));
  } else {
    const stats = await Promise.all(
      dirents.map((d) => stat(join(abs, d.name)).catch(() => null)),
    );
    entries = dirents.map((d, i) => ({
      name: d.name,
      is_dir: d.isDirectory(),
      mtime_ms: stats[i]?.mtimeMs ?? 0,
      size: stats[i]?.size ?? 0,
    }));
  }

  entries.sort(sorterFor(sort));

  const total = entries.length;
  const page = entries.slice(offset, offset + limit).map((e): DirEntry => {
    const meta = e.is_dir ? null : childIndex.get(e.name);
    return {
      name: e.name,
      is_dir: e.is_dir,
      label: meta?.label ?? null,
      short_description: meta?.short_description ?? null,
    };
  });

  const pagination: ListingPage = { offset, limit, total, sort };
  return c.html(renderDirectoryListing(relPath, page, pagination));
}

interface SortableEntry {
  name: string;
  is_dir: boolean;
  mtime_ms: number;
  size: number;
}

function sorterFor(sort: ListingSort): (a: SortableEntry, b: SortableEntry) => number {
  if (sort === "mtime") {
    return (a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      // Most recent first.
      return b.mtime_ms - a.mtime_ms;
    };
  }
  if (sort === "size") {
    return (a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      // Largest first; directories sort by name among themselves
      // (their size is always 0).
      if (a.is_dir && b.is_dir) return a.name.localeCompare(b.name);
      return b.size - a.size;
    };
  }
  return (a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  };
}

function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LISTING_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    return DEFAULT_LISTING_LIMIT;
  }
  return Math.min(n, MAX_LISTING_LIMIT);
}

function parseOffset(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 0;
  return n;
}

function parseSort(raw: string | undefined): ListingSort {
  if (raw && (VALID_SORTS as string[]).includes(raw)) return raw as ListingSort;
  return "name";
}

function buildEtag(st: Stats): string {
  return `W/"${Math.floor(st.mtimeMs)}-${st.size}"`;
}

function etagMatches(etag: string, header: string): boolean {
  // RFC 9110: If-None-Match is a comma-separated list. `*` matches
  // anything. Weak-compare both sides (everything we emit is weak).
  if (header.trim() === "*") return true;
  return header
    .split(",")
    .map((s) => s.trim())
    .some((candidate) => candidate === etag);
}

function cacheHeaders(etag: string): Record<string, string> {
  return {
    "cache-control": "no-cache, must-revalidate",
    etag,
  };
}

interface ChildMeta {
  label: string | null;
  short_description: string | null;
}

async function loadChildIndex(relPath: string): Promise<Map<string, ChildMeta>> {
  const sql = createSql();
  // Match immediate children only: paths starting with the dir prefix
  // and with no further `/` after it. Root (`relPath === ""`) → any
  // path with no slash at all.
  let rows: { path: string; label: string | null; properties: unknown }[];
  if (relPath === "") {
    rows = (await sql`
      SELECT path, label, properties
      FROM artifacts
      WHERE path NOT LIKE '%/%'
    `) as { path: string; label: string | null; properties: unknown }[];
  } else {
    const prefix = `${relPath}/`;
    const wildcard = `${prefix}%`;
    const deeper = `${prefix}%/%`;
    rows = (await sql.query(
      `SELECT path, label, properties
         FROM artifacts
        WHERE path LIKE ? AND path NOT LIKE ?`,
      [wildcard, deeper],
    )) as { path: string; label: string | null; properties: unknown }[];
  }
  const index = new Map<string, ChildMeta>();
  const prefixLen = relPath === "" ? 0 : relPath.length + 1;
  for (const row of rows) {
    const basename = row.path.slice(prefixLen);
    const props = (row.properties as Record<string, unknown> | null) ?? {};
    const desc = props.short_description;
    index.set(basename, {
      label: row.label,
      short_description: typeof desc === "string" && desc.length > 0 ? desc : null,
    });
  }
  return index;
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
