// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Helpers for the /contribute endpoint: label normalization, slug generation,
 * exact-match wiki lookup, and per-path write serialization.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { createSql } from "./sql.js";

export interface MatchedWiki {
  id: string;
  source_path: string;
  properties: Record<string, unknown>;
}

/**
 * Canonicalize a label for exact-match comparison: lowercase, trim, collapse
 * internal whitespace. NFKC handles compatibility forms (e.g. half-width).
 */
export function normalizeLabel(s: string): string {
  return s.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Convert a label to a URL-safe path component. Empty input falls back to
 * "untitled" so callers always get a usable filename stem.
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
 * Compute the placeholder path for a new wiki: `wiki/{type}/{slug}.md`.
 * Falls back to `wiki/wiki/...` when subject_type is missing (per spec).
 */
export function placeholderPath(subjectType: string | undefined, label: string): string {
  const dir = subjectType ? slugify(subjectType) : "wiki";
  return `wiki/${dir}/${slugify(label)}.md`;
}

/**
 * If the desired path is taken on disk, append `-2`, `-3`, ... to the stem
 * until a free slot is found. Used to avoid clobbering unrelated wikis that
 * happen to slugify to the same name.
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

/**
 * Find an existing wiki in a space whose label or any alias matches the
 * candidate (after normalization). Returns the first match, or null.
 *
 * Linear scan over wikis in the space — fine at the scale we care about
 * for v1. Replace with a normalized-label index if it ever gets hot.
 */
export async function findMatchingWiki(
  spaceId: string,
  candidateLabel: string,
  candidateAliases: string[] = [],
): Promise<MatchedWiki | null> {
  const sql = createSql();
  const targets = new Set([
    normalizeLabel(candidateLabel),
    ...candidateAliases.map(normalizeLabel),
  ]);

  const rows = await sql`
    SELECT id, label, source_path, properties
    FROM entities
    WHERE space_id = ${spaceId} AND type = 'wiki'
  `;

  for (const row of rows) {
    const label = row.label as string;
    const props = (row.properties ?? {}) as Record<string, unknown>;
    if (targets.has(normalizeLabel(label))) {
      return { id: row.id as string, source_path: row.source_path as string, properties: props };
    }
    const aliases = Array.isArray(props.aliases) ? (props.aliases as unknown[]) : [];
    for (const a of aliases) {
      if (typeof a === "string" && targets.has(normalizeLabel(a))) {
        return {
          id: row.id as string,
          source_path: row.source_path as string,
          properties: props,
        };
      }
    }
  }

  return null;
}

// ── Per-path write serialization ────────────────────────────────────
//
// Two POST /contribute calls landing on the same wiki at the same time
// must not lose entries. Each path gets its own promise chain — work
// scheduled for the same path runs serially; different paths run in
// parallel. In-process only; cross-process locking is out of scope.

const _pathQueues = new Map<string, Promise<unknown>>();

export function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = _pathQueues.get(path) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  _pathQueues.set(
    path,
    next.catch(() => {}),
  );
  return next;
}
