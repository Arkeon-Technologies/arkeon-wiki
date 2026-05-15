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
