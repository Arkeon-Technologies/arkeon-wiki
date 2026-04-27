// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Contribution routing: append a (source, subject, excerpt) triple to a
 * target wiki, either an existing one matched by label/alias or a fresh
 * placeholder file. Frontmatter is canonical; this module owns the
 * read-modify-write of `contributions[]` and triggers a sync to mirror
 * into the SQLite index.
 *
 * Internal-only: there is no HTTP route. The contributor and editor
 * workers (forthcoming) call `contribute()` directly. External
 * contributors edit wiki files on disk; the watcher does the rest.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { createSql } from "./sql.js";
import { generateUlid } from "./ids.js";
import { ApiError } from "./errors.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { syncFile, type Space } from "./sync.js";

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

// ── Keyed write serialization ───────────────────────────────────────
//
// Two contribute() calls that race on the same key would interleave
// findMatchingWiki / findFreePath / writeFile — both could decide to
// create the same wiki, then one would overwrite the other's entity
// row. We serialize the full lookup-and-act sequence on a key (the
// space id, in practice) so each operation observes the previous one's
// committed state. In-process only; cross-process locking is out of
// scope.

const _keyQueues = new Map<string, Promise<unknown>>();

export function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = _keyQueues.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  _keyQueues.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

// ── Orchestration ───────────────────────────────────────────────────

export interface ContributeInput {
  space_id: string;
  source_id?: string | null;
  subject: {
    label: string;
    subject_type?: string;
    aliases?: string[];
  };
  excerpt: string;
  claim?: string;
}

export interface ContributeResult {
  wiki_id: string;
  wiki_path: string;
  was_created: boolean;
  contribution_id: string;
}

interface ContributionEntry {
  id: string;
  source_id: string | null;
  excerpt: string;
  claim: string | null;
  added_at: string;
}

/**
 * Append a contribution to a target wiki, creating a placeholder if no
 * existing wiki matches by label/alias. Throws ApiError on validation
 * failure or unknown space/source.
 */
export async function contribute(input: ContributeInput): Promise<ContributeResult> {
  if (!input.space_id) {
    throw new ApiError(400, "validation_error", "space_id is required");
  }
  if (!input.subject?.label || typeof input.subject.label !== "string") {
    throw new ApiError(400, "validation_error", "subject.label is required");
  }
  if (!input.excerpt || typeof input.excerpt !== "string") {
    throw new ApiError(400, "validation_error", "excerpt is required");
  }

  const sql = createSql();

  const spaceRows = await sql`
    SELECT id, name, watch_dir FROM spaces WHERE id = ${input.space_id}
  `;
  if (spaceRows.length === 0) {
    throw new ApiError(404, "not_found", "Space not found");
  }
  const space: Space = {
    id: spaceRows[0].id as string,
    name: spaceRows[0].name as string,
    watch_dir: spaceRows[0].watch_dir as string,
  };

  if (input.source_id) {
    const sourceRows = await sql`
      SELECT id FROM entities
      WHERE id = ${input.source_id} AND space_id = ${input.space_id}
    `;
    if (sourceRows.length === 0) {
      throw new ApiError(404, "not_found", "source_id not found in this space");
    }
  }

  const contribution: ContributionEntry = {
    id: generateUlid(),
    source_id: input.source_id ?? null,
    excerpt: input.excerpt,
    claim: input.claim ?? null,
    added_at: new Date().toISOString(),
  };

  // Serialize on the space so the lookup-and-act sequence is atomic with
  // respect to other contributions in the same space. Different spaces
  // proceed in parallel.
  return withPathLock(`space::${space.id}`, async () => {
    const match = await findMatchingWiki(
      space.id,
      input.subject.label,
      input.subject.aliases ?? [],
    );

    if (match) {
      const wikiPath = match.source_path;
      const absPath = join(space.watch_dir, wikiPath);
      const content = readFileSync(absPath, "utf-8");
      const parsed = parseFrontmatter(content);
      const existing = Array.isArray(parsed.properties.contributions)
        ? (parsed.properties.contributions as unknown[])
        : [];
      const updated = {
        ...parsed.properties,
        contributions: [...existing, contribution],
      };
      writeFileSync(absPath, serializeFrontmatter(updated, parsed.body), "utf-8");
      await syncFile(space, wikiPath);

      return {
        wiki_id: match.id,
        wiki_path: wikiPath,
        was_created: false,
        contribution_id: contribution.id,
      };
    }

    const wikiId = generateUlid();
    const desiredPath = placeholderPath(input.subject.subject_type, input.subject.label);
    const wikiPath = findFreePath(space.watch_dir, desiredPath);
    const absPath = join(space.watch_dir, wikiPath);
    mkdirSync(dirname(absPath), { recursive: true });

    const props: Record<string, unknown> = {
      id: wikiId,
      label: input.subject.label,
    };
    if (input.subject.subject_type) props.subject_type = input.subject.subject_type;
    if (input.subject.aliases?.length) props.aliases = input.subject.aliases;
    props.status = "placeholder";
    props.contributions = [contribution];

    writeFileSync(absPath, serializeFrontmatter(props, ""), "utf-8");
    await syncFile(space, wikiPath);

    return {
      wiki_id: wikiId,
      wiki_path: wikiPath,
      was_created: true,
      contribution_id: contribution.id,
    };
  });
}
