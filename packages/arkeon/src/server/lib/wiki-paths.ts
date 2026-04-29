// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers for routing labels to wiki file paths.
 *
 * `slugify` and `normalizeLabel` are general-purpose string tidiers.
 * `placeholderPath` and `findFreePath` are the two-step routing the
 * ingestor uses when creating a new wiki for a subject: pick the
 * deterministic preferred path, then nudge it forward if there's a
 * collision.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Canonicalize a label for exact-match comparison: lowercase, trim,
 * collapse internal whitespace. NFKC handles compatibility forms
 * (e.g. half-width characters).
 */
export function normalizeLabel(s: string): string {
  return s.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Convert a label to a URL-safe path component. Empty input falls back
 * to "untitled" so callers always get a usable filename stem.
 */
export function slugify(s: string): string {
  const slug = s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "untitled";
}

/**
 * Compute the preferred path for a new wiki: `wiki/{type}/{slug}.md`.
 * Falls back to `wiki/wiki/...` when subject_type is missing.
 */
export function wikiPathFor(
  subjectType: string | undefined,
  label: string,
): string {
  const dir = subjectType ? slugify(subjectType) : "wiki";
  return `wiki/${dir}/${slugify(label)}.md`;
}

/**
 * If the desired path is taken on disk, append `-2`, `-3`, ... to the
 * stem until a free slot is found. Used to avoid clobbering unrelated
 * wikis whose labels happen to slugify to the same name.
 */
export function findFreePath(watchDir: string, basePath: string): string {
  if (!existsSync(join(watchDir, basePath))) return basePath;
  const ext = ".md";
  const stem = basePath.endsWith(ext) ? basePath.slice(0, -ext.length) : basePath;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(join(watchDir, candidate))) return candidate;
  }
  throw new Error(`Could not find free path for ${basePath}`);
}
