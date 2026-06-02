// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Query primitives over the substrate schema (artifacts / tags / links).
 *
 * Exposed via the six-command HTTP layer in routes/space-scoped.ts.
 * `listArtifacts` powers POST /query; `setTag` / `deleteTag` /
 * `getArtifact` / `getBacklinks` back the other five.
 */

import { ApiError } from "./errors.js";
import { createSql } from "./sql.js";

export type ArtifactKind = "text" | "asset";

export interface QueryOptions {
  /** Restrict to artifacts whose path starts with this prefix (no trailing slash). */
  folder?: string | null;
  kinds?: ArtifactKind[] | null;
  /** Tag keys (or "key:value" strings) that must be present. AND across entries. */
  has_tag?: string[] | null;
  /** Tag keys (or "key:value" strings) that must NOT be present. */
  not_tag?: string[] | null;
  /** FTS5 match query over artifact body text. */
  text?: string | null;
  limit?: number | null;
  offset?: number | null;
}

export interface ArtifactRow {
  path: string;
  kind: ArtifactKind;
  label: string | null;
  source_hash: string;
  properties: Record<string, unknown>;
  tags: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface ListResult {
  artifacts: ArtifactRow[];
  total: number;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Parse a `kinds` request field. Accepts either a string array
 * (`["text", "asset"]`, the documented form), or a comma-separated
 * string (`"text,asset"`) for backward-compat with the older surface.
 */
export function parseKinds(raw: unknown): ArtifactKind[] | null {
  if (raw == null) return null;
  let parts: string[];
  if (Array.isArray(raw)) {
    parts = raw.flatMap((v) => (typeof v === "string" ? v.split(",") : []));
  } else if (typeof raw === "string") {
    parts = raw.split(",");
  } else {
    throw new ApiError(400, "validation_error", `kinds must be string[] or "text,asset"`);
  }
  const kinds: ArtifactKind[] = [];
  for (const p of parts) {
    const trimmed = p.trim();
    if (trimmed === "text" || trimmed === "asset") kinds.push(trimmed);
    else if (trimmed !== "")
      throw new ApiError(400, "validation_error", `Invalid kind: ${trimmed}`);
  }
  return kinds.length > 0 ? kinds : null;
}

/**
 * Split "key:value" tag specs into key + optional value parts.
 * "key" alone → presence check (value omitted).
 */
function parseTagSpec(spec: string): { key: string; value: string | null } {
  const idx = spec.indexOf(":");
  if (idx < 0) return { key: spec, value: null };
  return { key: spec.slice(0, idx), value: spec.slice(idx + 1) };
}

export async function listArtifacts(opts: QueryOptions): Promise<ListResult> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.folder) {
    const prefix = opts.folder.endsWith("/") ? opts.folder : opts.folder + "/";
    where.push("(a.path = ? OR a.path LIKE ?)");
    params.push(opts.folder, prefix + "%");
  }
  if (opts.kinds && opts.kinds.length > 0) {
    where.push(`a.kind IN (${opts.kinds.map(() => "?").join(",")})`);
    params.push(...opts.kinds);
  }
  if (opts.has_tag) {
    for (const spec of opts.has_tag) {
      const { key, value } = parseTagSpec(spec);
      if (value == null) {
        where.push("EXISTS (SELECT 1 FROM tags t WHERE t.path = a.path AND t.key = ?)");
        params.push(key);
      } else {
        where.push("EXISTS (SELECT 1 FROM tags t WHERE t.path = a.path AND t.key = ? AND t.value = ?)");
        params.push(key, value);
      }
    }
  }
  if (opts.not_tag) {
    for (const spec of opts.not_tag) {
      const { key, value } = parseTagSpec(spec);
      if (value == null) {
        where.push("NOT EXISTS (SELECT 1 FROM tags t WHERE t.path = a.path AND t.key = ?)");
        params.push(key);
      } else {
        where.push("NOT EXISTS (SELECT 1 FROM tags t WHERE t.path = a.path AND t.key = ? AND t.value = ?)");
        params.push(key, value);
      }
    }
  }
  if (opts.text) {
    where.push("EXISTS (SELECT 1 FROM fts_artifacts f WHERE f.path = a.path AND f.text MATCH ?)");
    params.push(opts.text);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);

  const sql = createSql();

  const totalRow = (await sql.query(
    `SELECT COUNT(*) AS n FROM artifacts a ${whereSql}`,
    params,
  )) as { n: number }[];
  const total = Number(totalRow[0]?.n ?? 0);

  const rows = (await sql.query(
    `SELECT a.path, a.kind, a.label, a.source_hash, a.properties,
            a.created_at, a.updated_at
     FROM artifacts a
     ${whereSql}
     ORDER BY a.updated_at DESC, a.path ASC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )) as Array<{
    path: string;
    kind: ArtifactKind;
    label: string | null;
    source_hash: string;
    // sql.ts:hydrateRow auto-parses `properties` from JSON-string → object
    // before rows leave the SQL layer. Don't re-parse downstream.
    properties: Record<string, unknown> | null;
    created_at: string;
    updated_at: string;
  }>;

  // Hydrate tags in a second query (avoids exploding row counts on JOIN).
  const paths = rows.map((r) => r.path);
  const tagsByPath: Record<string, Record<string, string>> = {};
  if (paths.length > 0) {
    const tagRows = (await sql.query(
      `SELECT path, key, value FROM tags
       WHERE path IN (${paths.map(() => "?").join(",")})`,
      paths,
    )) as Array<{ path: string; key: string; value: string }>;
    for (const t of tagRows) {
      (tagsByPath[t.path] ??= {})[t.key] = t.value;
    }
  }

  const artifacts: ArtifactRow[] = rows.map((r) => ({
    path: r.path,
    kind: r.kind,
    label: r.label,
    source_hash: r.source_hash,
    properties: r.properties ?? {},
    tags: tagsByPath[r.path] ?? {},
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));

  return { artifacts, total };
}

export interface RedlinkRow {
  target_path: string;
  demand: number;
  linked_from: string[];
}

export interface RedlinkResult {
  redlinks: RedlinkRow[];
  total: number;
}

export interface ListRedlinksOptions {
  folder?: string | null;
  limit?: number | null;
  offset?: number | null;
}

export async function listRedlinks(opts: ListRedlinksOptions): Promise<RedlinkResult> {
  const sql = createSql();
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);

  const where: string[] = ["a.path IS NULL"];
  const params: unknown[] = [];
  if (opts.folder) {
    const prefix = opts.folder.endsWith("/") ? opts.folder : opts.folder + "/";
    where.push("(l.target_path LIKE ? OR l.target_path = ?)");
    params.push(prefix + "%", opts.folder);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;

  const totalRow = (await sql.query(
    `SELECT COUNT(DISTINCT l.target_path) AS n
     FROM links l
     LEFT JOIN artifacts a ON a.path = l.target_path
     ${whereSql}`,
    params,
  )) as { n: number }[];
  const total = Number(totalRow[0]?.n ?? 0);

  // U+001F (ASCII Unit Separator) — a control character that can't
  // appear in a filesystem path, so we can split the GROUP_CONCAT
  // result back into individual source paths losslessly. Interpolate
  // through char(31) on the SQL side so the source-level character
  // is visible (not a hidden control byte embedded in a string literal).
  const rows = (await sql.query(
    `SELECT l.target_path,
            COUNT(*) AS demand,
            GROUP_CONCAT(l.source_path, char(31)) AS linked_from_concat
     FROM links l
     LEFT JOIN artifacts a ON a.path = l.target_path
     ${whereSql}
     GROUP BY l.target_path
     ORDER BY demand DESC, l.target_path ASC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )) as Array<{ target_path: string; demand: number; linked_from_concat: string }>;

  const redlinks: RedlinkRow[] = rows.map((r) => ({
    target_path: r.target_path,
    demand: Number(r.demand),
    linked_from: (r.linked_from_concat ?? "")
      .split("\x1f")
      .filter(Boolean)
      .slice(0, 3),
  }));

  return { redlinks, total };
}

export interface BacklinkRow {
  source_path: string;
  link_text: string | null;
  attrs: Record<string, string>;
  created_at: string;
}

export interface BacklinksResult {
  /** Whether `path` resolves to a real artifact (false → redlink target). */
  exists: boolean;
  /** Anchor count, matching the demand field in /redlinks. */
  demand: number;
  backlinks: BacklinkRow[];
}

/**
 * Inbound link rows pointing at `path`. Works uniformly whether
 * `path` resolves to a real artifact or is an unresolved redlink
 * target — the difference shows up in the `exists` field.
 */
export async function getBacklinks(path: string): Promise<BacklinksResult> {
  const sql = createSql();
  const existsRows = (await sql.query(
    `SELECT 1 AS x FROM artifacts WHERE path = ? LIMIT 1`,
    [path],
  )) as { x: number }[];
  const rows = (await sql.query(
    `SELECT source_path, link_text, attrs, created_at
     FROM links
     WHERE target_path = ?
     ORDER BY created_at ASC`,
    [path],
  )) as Array<{ source_path: string; link_text: string | null; attrs: string; created_at: string }>;
  const backlinks: BacklinkRow[] = rows.map((r) => ({
    source_path: r.source_path,
    link_text: r.link_text,
    attrs: parseJsonObject(r.attrs) as Record<string, string>,
    created_at: r.created_at,
  }));
  return {
    exists: existsRows.length > 0,
    demand: backlinks.length,
    backlinks,
  };
}

export async function getArtifact(path: string): Promise<ArtifactRow | null> {
  const sql = createSql();
  const rows = await sql`
    SELECT path, kind, label, source_hash, properties, created_at, updated_at
    FROM artifacts WHERE path = ${path}
  `;
  if (rows.length === 0) return null;
  const r = rows[0] as Record<string, unknown>;
  const tagRows = await sql`SELECT key, value FROM tags WHERE path = ${path}`;
  const tags: Record<string, string> = {};
  for (const t of tagRows) tags[t.key as string] = t.value as string;
  return {
    path: r.path as string,
    kind: r.kind as ArtifactKind,
    label: (r.label as string | null) ?? null,
    source_hash: r.source_hash as string,
    // sql.ts:hydrateRow already parsed `properties` from JSON-string to
    // object — don't double-parse.
    properties: (r.properties as Record<string, unknown> | null) ?? {},
    tags,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

export type SetTagAction = "created" | "updated" | "unchanged";

export interface SetTagResult {
  /** Value present before this call; null if the key didn't exist yet. */
  previous_value: string | null;
  /**
   *  - `"created"` — key didn't exist; row inserted.
   *  - `"updated"` — key existed with a different value; row replaced.
   *  - `"unchanged"` — key existed with the same value; no write needed.
   *
   * Workers can detect collisions by checking whether `previous_value`
   * came from a different worker than themselves.
   */
  action: SetTagAction;
}

export async function setTag(
  path: string,
  key: string,
  value: string,
): Promise<SetTagResult> {
  const sql = createSql();
  const existing = (await sql.query(
    `SELECT value FROM tags WHERE path = ? AND key = ? LIMIT 1`,
    [path, key],
  )) as { value: string }[];
  const previous_value = existing.length > 0 ? existing[0].value : null;
  const action: SetTagAction =
    previous_value === null
      ? "created"
      : previous_value === value
        ? "unchanged"
        : "updated";
  if (action !== "unchanged") {
    await sql.query(
      `INSERT INTO tags (path, key, value) VALUES (?, ?, ?)
       ON CONFLICT (path, key) DO UPDATE SET value = excluded.value`,
      [path, key, value],
    );
  }
  return { previous_value, action };
}

export async function deleteTag(path: string, key: string): Promise<boolean> {
  const sql = createSql();
  const rows = await sql.query(
    `DELETE FROM tags WHERE path = ? AND key = ? RETURNING key`,
    [path, key],
  );
  return rows.length > 0;
}

/**
 * Parse a JSON-string column into an object. Note: `sql.ts:hydrateRow`
 * already auto-parses `properties` and `tags` — do NOT call this on
 * those columns or you'll silently turn the object into `{}`. Only
 * `attrs` (from `links`) needs explicit parsing here.
 */
function parseJsonObject(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
