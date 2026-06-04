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

export type QueryOrderBy = "updated_at" | "created_at" | "path";
export type QueryOrder = "asc" | "desc";

export interface QueryOptions {
  /** Restrict to artifacts whose path starts with this prefix (no trailing slash). */
  folder?: string | null;
  kinds?: ArtifactKind[] | null;
  /** Tag keys (or "key:value" strings) that must be present. AND across entries. */
  has_tag?: string[] | null;
  /** Tag keys (or "key:value" strings) that must NOT be present. */
  not_tag?: string[] | null;
  /**
   * `artifacts.properties` keys (or "key:value" strings) that must be
   * present. Same syntax as `has_tag` — split on the first `:` into
   * key + value. Value comparison is string-equality against the
   * JSON-extracted scalar (numbers / booleans get stringified).
   * Useful for filtering on `<meta name="X" content="Y">` values that
   * land in `properties[X]`, or substrate-set fields like
   * `properties.derived_from` on extractor-produced assets.
   */
  has_property?: string[] | null;
  /** Property keys (or "key:value" strings) that must NOT be present. */
  not_property?: string[] | null;
  /** FTS5 match query over artifact body text. */
  text?: string | null;
  /** Sort column. Default: `updated_at`. */
  order_by?: QueryOrderBy | null;
  /** Sort direction. Default: `desc` for time columns, `asc` for path. */
  order?: QueryOrder | null;
  limit?: number | null;
  offset?: number | null;
}

const ORDER_BY_COLUMN: Record<QueryOrderBy, string> = {
  updated_at: "a.updated_at",
  created_at: "a.created_at",
  path: "a.path",
};

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
 * "key" alone → presence check (value omitted). Shared between
 * `has_tag` / `not_tag` and `has_property` / `not_property`.
 */
function parseTagSpec(spec: string): { key: string; value: string | null } {
  const idx = spec.indexOf(":");
  if (idx < 0) return { key: spec, value: null };
  return { key: spec.slice(0, idx), value: spec.slice(idx + 1) };
}

/**
 * Build the SQLite `json_extract` path for a properties key. Keys
 * arrive from user input (HTML meta tags) so we have to defend
 * against quotes inside the JSON pointer; the `replace` produces the
 * `'$."escaped"'` form SQLite parses.
 */
function jsonPropertyPath(key: string): string {
  return `$."${key.replace(/"/g, '""')}"`;
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
  if (opts.has_property) {
    for (const spec of opts.has_property) {
      const { key, value } = parseTagSpec(spec);
      const path = jsonPropertyPath(key);
      if (value == null) {
        // `json_extract(props, path)` returns NULL when the key is
        // absent. Check `json_type` instead so "key set to JSON null"
        // still counts as present.
        where.push("json_type(a.properties, ?) IS NOT NULL");
        params.push(path);
      } else {
        where.push("CAST(json_extract(a.properties, ?) AS TEXT) = ?");
        params.push(path, value);
      }
    }
  }
  if (opts.not_property) {
    for (const spec of opts.not_property) {
      const { key, value } = parseTagSpec(spec);
      const path = jsonPropertyPath(key);
      if (value == null) {
        where.push("json_type(a.properties, ?) IS NULL");
        params.push(path);
      } else {
        where.push(
          "(json_type(a.properties, ?) IS NULL OR CAST(json_extract(a.properties, ?) AS TEXT) != ?)",
        );
        params.push(path, path, value);
      }
    }
  }
  // When `text` is set, drive the query from `fts_artifacts` and JOIN
  // back to `artifacts`. The obvious form — `EXISTS (SELECT 1 FROM
  // fts_artifacts f WHERE f.path = a.path AND f.text MATCH ?)` — plans
  // as `SCAN artifacts` + per-row FTS lookup, which is O(N_corpus) per
  // query. Driving from the FTS virtual table lets SQLite use the FTS
  // index directly. Measured ~70x on a 3k-doc corpus.
  let fromSql = "FROM artifacts a";
  if (opts.text) {
    fromSql = "FROM fts_artifacts f JOIN artifacts a ON a.path = f.path";
    where.push("f.text MATCH ?");
    params.push(opts.text);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(opts.offset ?? 0, 0);

  const sql = createSql();

  const totalRow = (await sql.query(
    `SELECT COUNT(*) AS n ${fromSql} ${whereSql}`,
    params,
  )) as { n: number }[];
  const total = Number(totalRow[0]?.n ?? 0);

  const orderBy = opts.order_by ?? "updated_at";
  const orderCol = ORDER_BY_COLUMN[orderBy];
  const orderDir =
    (opts.order ?? (orderBy === "path" ? "asc" : "desc")) === "asc" ? "ASC" : "DESC";
  const rows = (await sql.query(
    `SELECT a.path, a.kind, a.label, a.source_hash, a.properties,
            a.created_at, a.updated_at
     ${fromSql}
     ${whereSql}
     ORDER BY ${orderCol} ${orderDir}, a.path ASC
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

/**
 * fs-path form = the target carries a folder ("/") or extension (".").
 * Slug form = neither — only emitted by Markdown `[[X]]` redlinks that
 * stay literal until a basename match lands. (Strictly: HTML hrefs
 * always normalize to a path with at least a "." or "/", so fs-form
 * uniquely identifies "the harness needs to drop a file at this path"
 * vs. "the harness can drop a file at any basename match.")
 */
function isFsPathForm(target: string): boolean {
  return target.includes("/") || target.includes(".");
}

/** Lowercased basename with the trailing extension stripped. */
function basenameStem(target: string): string {
  const slashIdx = target.lastIndexOf("/");
  const base = slashIdx >= 0 ? target.slice(slashIdx + 1) : target;
  const dotIdx = base.lastIndexOf(".");
  const stem = dotIdx > 0 ? base.slice(0, dotIdx) : base;
  return stem.toLowerCase();
}

type RedlinkBucket = { target_path: string; sources: string[] };

/**
 * Group raw redlink anchor rows into dedup buckets. Mirrors the
 * substrate's link-resolution semantics so the queue summary doesn't
 * lie about how anchors WILL resolve when a file lands:
 *
 *   - Each unique fs-path target stays its own row. `iarpa/wiki.html`
 *     and `chartbook/wiki.html` are two distinct gaps — creating one
 *     file resolves anchors that named exactly that path; cross-folder
 *     anchors at the same basename do not collapse.
 *
 *   - An MD slug redlink (`[[wiki]]`, no slash/dot) merges into a fs-
 *     path bucket IFF exactly one fs-path bucket shares its basename
 *     stem. That's the same condition `resolveWikilink()` uses to
 *     resolve `[[wiki]]` at extraction time — one match wins; zero or
 *     two+ leave the slug literal. So the slug shows as its own row
 *     when (a) no fs-path anchor exists for it yet or (b) the basename
 *     is ambiguous across folders.
 *
 * Net effect: `demand` and `linked_from` describe a concrete unit of
 * work — "create the file at this path and these N anchors resolve."
 * Cross-folder same-basename anchors stay visible as separate work
 * items rather than masquerading as one.
 */
function aggregateRedlinks(
  rows: Array<{ target_path: string; source_path: string }>,
): RedlinkBucket[] {
  const fsBuckets = new Map<string, RedlinkBucket>();
  const slugBuckets = new Map<string, RedlinkBucket>();
  for (const r of rows) {
    if (isFsPathForm(r.target_path)) {
      let b = fsBuckets.get(r.target_path);
      if (!b) {
        b = { target_path: r.target_path, sources: [] };
        fsBuckets.set(r.target_path, b);
      }
      b.sources.push(r.source_path);
    } else {
      const key = r.target_path.toLowerCase();
      let b = slugBuckets.get(key);
      if (!b) {
        b = { target_path: r.target_path, sources: [] };
        slugBuckets.set(key, b);
      }
      b.sources.push(r.source_path);
    }
  }

  const fsByStem = new Map<string, RedlinkBucket[]>();
  for (const b of fsBuckets.values()) {
    const stem = basenameStem(b.target_path);
    let arr = fsByStem.get(stem);
    if (!arr) {
      arr = [];
      fsByStem.set(stem, arr);
    }
    arr.push(b);
  }

  const standaloneSlugs: RedlinkBucket[] = [];
  for (const slug of slugBuckets.values()) {
    const matches = fsByStem.get(slug.target_path.toLowerCase()) ?? [];
    if (matches.length === 1) {
      matches[0].sources.push(...slug.sources);
    } else {
      standaloneSlugs.push(slug);
    }
  }

  return [...fsBuckets.values(), ...standaloneSlugs];
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

  // Pull every unresolved anchor and group in JS. The slug-into-fs-
  // path merge depends on a corpus-wide basename uniqueness check
  // that's awkward in SQLite (no REVERSE, no rfind); the redlink
  // queue is bounded by the unresolved-link count, which stays small
  // in practice.
  const rows = (await sql.query(
    `SELECT l.target_path, l.source_path
     FROM links l
     LEFT JOIN artifacts a ON a.path = l.target_path
     ${whereSql}`,
    params,
  )) as Array<{ target_path: string; source_path: string }>;

  const buckets = aggregateRedlinks(rows);

  const aggregated: RedlinkRow[] = buckets.map((b) => {
    const seen = new Set<string>();
    const linked_from: string[] = [];
    for (const s of b.sources) {
      if (seen.has(s)) continue;
      seen.add(s);
      linked_from.push(s);
      if (linked_from.length === 3) break;
    }
    return {
      target_path: b.target_path,
      demand: b.sources.length,
      linked_from,
    };
  });

  aggregated.sort((a, b) => {
    if (a.demand !== b.demand) return b.demand - a.demand;
    if (a.target_path < b.target_path) return -1;
    if (a.target_path > b.target_path) return 1;
    return 0;
  });

  const total = aggregated.length;
  const redlinks = aggregated.slice(offset, offset + limit);

  return { redlinks, total };
}

export interface BacklinkRow {
  source_path: string;
  link_text: string | null;
  attrs: Record<string, string>;
  /**
   * Per-row last-sync timestamp — when sync.ts (re-)inserted this
   * specific anchor row. NOT "first time this anchor existed":
   * outbound links get DELETE+INSERTed wholesale on every source
   * re-extraction, so all of an article's backlinks share a
   * synced_at after any change to that article.
   */
  synced_at: string;
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
    `SELECT source_path, link_text, attrs, synced_at
     FROM links
     WHERE target_path = ?
     ORDER BY synced_at ASC`,
    [path],
  )) as Array<{ source_path: string; link_text: string | null; attrs: string; synced_at: string }>;
  const backlinks: BacklinkRow[] = rows.map((r) => ({
    source_path: r.source_path,
    link_text: r.link_text,
    attrs: parseJsonObject(r.attrs) as Record<string, string>,
    synced_at: r.synced_at,
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

/**
 * Validate a tag key. `:` is reserved because `has_tag` / `not_tag`
 * query specs use the first `:` to split key from value
 * (parseTagSpec). A key like `"status:published"` would be stored
 * verbatim but then collide with `key="status", value="published"`
 * on read — invisible until you list raw tags. Reject up front.
 */
export function validateTagKey(key: string): void {
  if (key.includes(":")) {
    throw new ApiError(
      400,
      "reserved_character",
      `tag key must not contain ":" (reserved as the key/value separator in has_tag / not_tag query specs); got ${JSON.stringify(key)}`,
    );
  }
}

export async function setTag(
  path: string,
  key: string,
  value: string,
): Promise<SetTagResult> {
  validateTagKey(key);
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
  validateTagKey(key);
  const sql = createSql();
  const rows = await sql.query(
    `DELETE FROM tags WHERE path = ? AND key = ? RETURNING key`,
    [path, key],
  );
  return rows.length > 0;
}

export interface CorpusStats {
  artifacts: { total: number; text: number; asset: number };
  /** Total link rows (one per anchor). */
  links: number;
  /** Distinct unresolved targets (the redlink queue size). */
  redlinks: number;
  /** Distinct tag keys in use. */
  tag_keys: number;
  /** Top tag keys by row count, descending. Capped by tag_keys_top option. */
  tag_keys_top: Array<{ key: string; n: number }>;
}

const TAG_KEYS_TOP_DEFAULT = 10;

export interface GetStatsOptions {
  /** How many rows to include in `tag_keys_top`. Defaults to 10. */
  tag_keys_top?: number;
}

export async function getStats(opts: GetStatsOptions = {}): Promise<CorpusStats> {
  const tagKeysTop = opts.tag_keys_top ?? TAG_KEYS_TOP_DEFAULT;
  const sql = createSql();
  const artifactsByKind = (await sql.query(
    `SELECT kind, COUNT(*) AS n FROM artifacts GROUP BY kind`,
    [],
  )) as { kind: ArtifactKind; n: number }[];
  let textN = 0;
  let assetN = 0;
  for (const r of artifactsByKind) {
    if (r.kind === "text") textN = Number(r.n);
    else if (r.kind === "asset") assetN = Number(r.n);
  }
  const [{ n: linksN }] = (await sql.query(
    `SELECT COUNT(*) AS n FROM links`,
    [],
  )) as { n: number }[];
  // Count redlinks via the same aggregation as listRedlinks so the
  // corpus number agrees with the row count harnesses see. We need the
  // raw (target_path, source_path) rows for aggregateRedlinks because
  // the slug-into-fs-path merge depends on whether the slug's basename
  // has exactly one fs-path match — a corpus-wide condition that can't
  // be derived from DISTINCT target_path alone.
  const redlinkRows = (await sql.query(
    `SELECT l.target_path, l.source_path FROM links l
     LEFT JOIN artifacts a ON a.path = l.target_path
     WHERE a.path IS NULL`,
    [],
  )) as Array<{ target_path: string; source_path: string }>;
  const redlinksN = aggregateRedlinks(redlinkRows).length;
  const [{ n: tagKeysN }] = (await sql.query(
    `SELECT COUNT(DISTINCT key) AS n FROM tags`,
    [],
  )) as { n: number }[];
  const tagKeysTopRows = (await sql.query(
    `SELECT key, COUNT(*) AS n FROM tags GROUP BY key ORDER BY n DESC, key ASC LIMIT ?`,
    [tagKeysTop],
  )) as Array<{ key: string; n: number }>;
  return {
    artifacts: { total: textN + assetN, text: textN, asset: assetN },
    links: Number(linksN),
    redlinks: Number(redlinksN),
    tag_keys: Number(tagKeysN),
    tag_keys_top: tagKeysTopRows.map((r) => ({ key: r.key, n: Number(r.n) })),
  };
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
