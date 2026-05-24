// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers for `POST /:space/inbox`. Two responsibilities:
 *
 *   1. Decide the on-disk path for a server-named source. Format is
 *      `sources/inbox/<YYYY-MM-DD>/<slug>.<md|txt>` (UTC date). If the
 *      candidate collides with an existing file, append `-2`, `-3`, ...
 *      until free. ULID prefix is the fallback when no title is given.
 *
 *   2. Build the file body from `{ text, title?, kind }`. With
 *      `kind: "md"` and a title we prepend a `# <title>` heading so the
 *      file is self-describing on disk. With `kind: "txt"` or no title
 *      we write the text verbatim (with a trailing newline).
 *
 * Path generation is pure modulo a `now` clock seam (for tests) and
 * an `exists` predicate (for collision testing without touching disk).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { generateUlid } from "./ids.js";

const SLUG_MAX_LEN = 60;
const MAX_COLLISION_SUFFIX = 999;

export type InboxKind = "md" | "txt";

/**
 * ASCII kebab-case slug. Drops non-alnum runs to a single hyphen,
 * lowercases, trims leading/trailing hyphens, caps length. Returns
 * an empty string for input that contains no slug-eligible characters
 * (caller falls back to a ULID prefix).
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // drop combining diacritics so "naïve" → "naive"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LEN)
    .replace(/-+$/, "");
}

/** `YYYY-MM-DD` in UTC for the given (or current) clock. */
export function utcDateStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface ResolveInboxPathOpts {
  watchDir: string;
  title?: string;
  kind: InboxKind;
  now?: Date;
  /**
   * Existence test seam — defaults to `fs.existsSync` against the
   * absolute path. Tests inject a custom predicate to verify the
   * auto-suffix loop without touching the filesystem.
   */
  exists?: (absPath: string) => boolean;
}

/**
 * Generate `{ relativePath }` for a new inbox file. Resolves to:
 *
 *     sources/inbox/<YYYY-MM-DD>/<slug>.<ext>
 *
 * Slug is derived from `title` (slugified). When the title is missing
 * or slugifies to empty, the slug is a 10-char ULID time component
 * (`generateUlid()` is 26 chars; we take the first 10 which is the
 * Crockford-encoded timestamp — still monotonic within a day, no need
 * for the random tail in the filename).
 *
 * On collision we append `-2`, `-3`, ... until free. The cap is a
 * pathological-safety guard; real workloads will never approach it.
 */
export function resolveInboxPath(opts: ResolveInboxPathOpts): {
  relativePath: string;
} {
  const date = utcDateStamp(opts.now);
  const ext = opts.kind === "txt" ? ".txt" : ".md";
  const exists = opts.exists ?? ((p: string) => existsSync(p));

  const titleSlug = opts.title ? slugify(opts.title) : "";
  const base = titleSlug || generateUlid().slice(0, 10).toLowerCase();

  for (let suffix = 1; suffix <= MAX_COLLISION_SUFFIX; suffix++) {
    const filename = suffix === 1 ? `${base}${ext}` : `${base}-${suffix}${ext}`;
    const relativePath = `sources/inbox/${date}/${filename}`;
    const abs = resolve(opts.watchDir, relativePath);
    if (!exists(abs)) {
      return { relativePath };
    }
  }
  throw new Error(
    `resolveInboxPath: too many collisions on slug '${base}' under sources/inbox/${date}/`,
  );
}

export interface BuildInboxContentOpts {
  text: string;
  title?: string;
  kind: InboxKind;
}

/**
 * Compose the file body.
 *
 *   - md + title : "# <title>\n\n<text>\n"
 *   - md no title: "<text>\n"
 *   - txt        : "<text>\n"  (title ignored — txt has no headings)
 *
 * Always ends with a single trailing newline. Strips trailing newlines
 * from `text` first so callers can hand us either form.
 */
export function buildInboxContent(opts: BuildInboxContentOpts): string {
  const body = opts.text.replace(/\n+$/, "");
  if (opts.kind === "md" && opts.title) {
    return `# ${opts.title}\n\n${body}\n`;
  }
  return `${body}\n`;
}

/**
 * Extensions the `add_source` agent tool will accept for URL captures.
 * Anything else returns an "unsupported media type" error so we don't
 * land arbitrary binaries (executables, archives, fonts) in the corpus.
 *
 * Lowercase, dot-included. Mirrors the watcher's TEXT_EXTENSIONS plus
 * the universal-safe image set and PDF (which lands as `kind='asset'`
 * but is the headline use case for URL-captured sources).
 */
export const ADD_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".pdf",
  ".html",
  ".htm",
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".xml",
  ".csv",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
]);

/**
 * Best-effort extension for an HTTP response when neither the URL path
 * nor a Content-Disposition gave us one. Keys are normalized media types
 * (`type/subtype`, no parameters, lowercase) and only cover MIMEs that
 * land in ADD_SOURCE_EXTENSIONS.
 */
export const MEDIA_TYPE_TO_EXTENSION: Readonly<Record<string, string>> = {
  "application/pdf": ".pdf",
  "text/html": ".html",
  "application/xhtml+xml": ".html",
  "text/markdown": ".md",
  "text/x-markdown": ".md",
  "text/plain": ".txt",
  "application/json": ".json",
  "application/xml": ".xml",
  "text/xml": ".xml",
  "text/csv": ".csv",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/** Parse the filename out of a Content-Disposition header value, if any.
 *  Handles both `filename=foo` and RFC 5987 `filename*=UTF-8''foo`. */
function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  // RFC 5987 extended form takes precedence — it carries proper encoding.
  const extMatch = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(header);
  if (extMatch && extMatch[1]) {
    try {
      return decodeURIComponent(extMatch[1].trim());
    } catch {
      // fall through to the simple form
    }
  }
  const simpleMatch = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(
    header,
  );
  const raw = simpleMatch ? simpleMatch[1] ?? simpleMatch[2] : null;
  return raw ? raw.trim() : null;
}

/** Pull the last path segment from a URL, ignoring query/hash. Returns
 *  the empty string for URLs whose path ends with `/` or is just `/`. */
function urlPathBasename(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "";
  }
  if (!pathname || pathname === "/" || pathname.endsWith("/")) return "";
  const slash = pathname.lastIndexOf("/");
  const tail = slash >= 0 ? pathname.slice(slash + 1) : pathname;
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

/** Lowercased, dot-included extension from a filename. Returns "" when
 *  there's no dot or the trailing segment looks like a versioned tail
 *  (`.tar.gz` → `.gz` is fine; agent extension allowlist filters). */
function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx < 0) return "";
  return filename.slice(idx).toLowerCase();
}

/** Split a filename into `{ stem, ext }` where `ext` is the lowercased
 *  extension (including the dot, or "") and `stem` is everything before. */
export function splitFilename(filename: string): { stem: string; ext: string } {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0) return { stem: filename, ext: "" };
  return { stem: filename.slice(0, idx), ext: filename.slice(idx).toLowerCase() };
}

export interface ResolveAddSourcePathOpts {
  watchDir: string;
  /** Pre-derived filename (`<stem><ext>`) — typically from extractFilenameFromUrl. */
  filename: string;
  now?: Date;
  exists?: (absPath: string) => boolean;
}

/**
 * Pick a collision-free `sources/inbox/<date>/<filename>` for a URL-
 * captured source. Mirrors `resolveInboxPath`'s auto-suffix loop but
 * accepts the extension verbatim instead of deriving it from `kind`,
 * so PDFs, images, etc. keep their original suffix.
 */
export function resolveAddSourcePath(
  opts: ResolveAddSourcePathOpts,
): { relativePath: string } {
  const date = utcDateStamp(opts.now);
  const exists = opts.exists ?? ((p: string) => existsSync(p));
  const { stem, ext } = splitFilename(opts.filename);
  for (let suffix = 1; suffix <= MAX_COLLISION_SUFFIX; suffix++) {
    const filename =
      suffix === 1 ? `${stem}${ext}` : `${stem}-${suffix}${ext}`;
    const relativePath = `sources/inbox/${date}/${filename}`;
    const abs = resolve(opts.watchDir, relativePath);
    if (!exists(abs)) {
      return { relativePath };
    }
  }
  throw new Error(
    `resolveAddSourcePath: too many collisions on '${stem}${ext}' under sources/inbox/${date}/`,
  );
}

export interface ExtractFilenameFromUrlOpts {
  url: string;
  /** Normalized media type (`type/subtype`, no parameters). */
  contentType: string;
  /** Raw Content-Disposition header value, or null if absent. */
  contentDisposition: string | null;
  now?: Date;
}

/**
 * Pick a safe on-disk filename for a URL-captured source.
 *
 * Resolution order:
 *   1. Content-Disposition filename, if present and its extension is on
 *      ADD_SOURCE_EXTENSIONS.
 *   2. URL pathname basename, if present and its extension is on
 *      ADD_SOURCE_EXTENSIONS.
 *   3. ULID fallback (`<ULID-10>.<ext-from-content-type>`), only when
 *      MEDIA_TYPE_TO_EXTENSION knows the media type.
 *
 * Returns `null` when no allowlisted extension can be derived — caller
 * surfaces `unsupported_media_type`. The returned filename is slugified
 * (ASCII kebab-case stem, original extension preserved).
 */
export function extractFilenameFromUrl(
  opts: ExtractFilenameFromUrlOpts,
): string | null {
  const candidates: string[] = [];
  const fromDisposition = parseContentDispositionFilename(opts.contentDisposition);
  if (fromDisposition) candidates.push(fromDisposition);
  const fromUrl = urlPathBasename(opts.url);
  if (fromUrl) candidates.push(fromUrl);

  for (const candidate of candidates) {
    const { stem, ext } = splitFilename(candidate);
    if (!ADD_SOURCE_EXTENSIONS.has(ext)) continue;
    const slug = slugify(stem);
    if (slug) return `${slug}${ext}`;
  }

  // ULID fallback. Only viable when we recognise the media type.
  const ext = MEDIA_TYPE_TO_EXTENSION[opts.contentType];
  if (!ext) return null;
  const stem = generateUlid().slice(0, 10).toLowerCase();
  return `${stem}${ext}`;
}
