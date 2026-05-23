// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Core sync primitive: bridge files on disk to entities in the database.
 *
 * `syncFile()` is the heart of arkeon-wiki. It reads a file from the
 * filesystem, parses it, and upserts the corresponding entity and
 * relationship rows. Everything else — the file watcher, agent edits,
 * CLI bootstrap — calls this function.
 *
 * Identity is the path. There are no ULIDs in this layer. A wiki at
 * `wiki/foo.html` has primary key (space_name, source_path) — write the
 * file, sync runs, the entity exists; delete the file, sync removes it.
 *
 * Wikis are HTML files under `wiki/` with a `.html` extension. Every
 * other indexed file is a "source" with type='file'. Relationships
 * come from `<a href>` elements in HTML wikis only; sources don't
 * extract outbound edges.
 */

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { createHash } from "node:crypto";

import { createSql, withTransaction, type SqlClient } from "./sql.js";
import { getEditContext, type EditKind } from "./edit-context.js";
import { classifyFile } from "./fs-watcher.js";
import { parseHtmlMeta } from "./html-meta.js";
import { extractHtmlLinks } from "./html-links.js";
import { loadSpacesMap } from "./spaces.js";

export interface Space {
  name: string;
  watch_dir: string;
}

export type EntityKind = "text" | "asset";

export interface SyncResult {
  action: "created" | "updated" | "unchanged" | "noop";
  type: "wiki" | "file";
  kind: EntityKind;
  label: string;
  linksExtracted: number;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * SHA-256 of a file's bytes, computed by streaming so a multi-GB video
 * doesn't try to fit in RAM. Used for asset entities — text files
 * already load the full content (we need to parse it), so they keep the
 * cheaper in-memory hash.
 */
async function fileContentHash(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export function isWikiPath(relativePath: string): boolean {
  return relativePath.startsWith("wiki/") && relativePath.endsWith(".html");
}

/**
 * Cheap change-detection fingerprint stored alongside `source_hash`.
 *
 * `source_hash` is canonical SHA-256 of content. `stat_fingerprint` is
 * `${mtimeMs}-${size}` — the same heuristic rsync / make / git status
 * use. When the fingerprint matches the stored value the file's bytes
 * are guaranteed identical to last sync, so we skip the content read
 * AND the hash recomputation. On a fingerprint miss we still compute
 * the real content hash; if it matches `source_hash`, the change was
 * a touch (refresh fingerprint, keep everything else); only a
 * genuine content change goes through the parse / relationship rebuild.
 *
 * This keeps `source_hash` semantically uniform across text and asset
 * rows while making syncs on unchanged files O(1) — particularly load-
 * bearing for large assets (GB-sized videos) where re-hashing on every
 * watcher debounce would be wasteful.
 */
function statFingerprint(stats: { mtimeMs: number; size: number }): string {
  return `${stats.mtimeMs}-${stats.size}`;
}

/**
 * Sync a single file from disk into the database.
 *
 * @param space - The space this file belongs to
 * @param relativePath - Path relative to the space's watch_dir
 * @returns Sync result describing what happened
 */
export async function syncFile(space: Space, relativePath: string): Promise<SyncResult> {
  const absPath = join(space.watch_dir, relativePath);

  // (1) Stat-fingerprint fast path. Skips content I/O entirely on
  // unchanged files — the common case during a reconcile walk.
  const stats = statSync(absPath);
  const fingerprint = statFingerprint(stats);

  const sql = createSql();
  const existing = await sql`
    SELECT source_hash, stat_fingerprint, type, kind, label
    FROM entities
    WHERE space_name = ${space.name} AND source_path = ${relativePath}
  `;

  if (
    existing.length > 0 &&
    existing[0].stat_fingerprint != null &&
    existing[0].stat_fingerprint === fingerprint
  ) {
    return {
      action: "unchanged",
      type: existing[0].type as "wiki" | "file",
      kind: (existing[0].kind as EntityKind) ?? "text",
      label: existing[0].label as string,
      linksExtracted: 0,
    };
  }

  // (2) Stat shifted — bytes might have changed, or it might just be
  // a touch. Classify and compute the real content hash to decide.
  const kind = classifyFile(relativePath, absPath);

  if (kind === "asset") {
    return syncAsset(space, relativePath, absPath, stats, fingerprint, existing[0] ?? null);
  }

  const content = readFileSync(absPath, "utf-8");
  const hash = contentHash(content);

  // (3) Touch-without-change: refresh the cache, but the row's
  // content-derived columns (label, properties, relationships) are
  // already correct. No parse, no updated_at bump.
  if (existing.length > 0 && existing[0].source_hash === hash) {
    await sql`
      UPDATE entities
      SET stat_fingerprint = ${fingerprint}
      WHERE space_name = ${space.name} AND source_path = ${relativePath}
    `;
    return {
      action: "unchanged",
      type: existing[0].type as "wiki" | "file",
      kind: (existing[0].kind as EntityKind) ?? "text",
      label: existing[0].label as string,
      linksExtracted: 0,
    };
  }

  // (4) Real content change.
  const result = isWikiPath(relativePath)
    ? await syncWiki(space, relativePath, content, hash, fingerprint, existing[0] ?? null)
    : await syncSource(space, relativePath, content, hash, fingerprint, existing[0] ?? null);

  await recordEntityEdit(space.name, relativePath, hash);

  return result;
}

async function syncWiki(
  space: Space,
  relativePath: string,
  content: string,
  hash: string,
  fingerprint: string,
  existing: Record<string, unknown> | null,
): Promise<SyncResult> {
  const meta = parseHtmlMeta(content);
  const label =
    meta.title ??
    (meta.properties.label as string | undefined) ??
    basename(relativePath, ".html");

  const propsJson = JSON.stringify(meta.properties);
  const spaces = await loadSpacesMap();
  const links = extractHtmlLinks(content, relativePath, {
    thisSpaceName: space.name,
    thisWatchDir: space.watch_dir,
    spaces,
  });
  const resolvedLinks = links.filter((l): l is typeof l & { resolved: string } => l.resolved !== null);

  await withTransaction(async (tx) => {
    if (existing) {
      await tx`
        UPDATE entities
        SET label = ${label},
            source_hash = ${hash},
            stat_fingerprint = ${fingerprint},
            properties = ${propsJson},
            kind = 'text',
            updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
        WHERE space_name = ${space.name} AND source_path = ${relativePath}
      `;
    } else {
      // updated_at is set explicitly with ms precision (matching the UPDATE
      // branch) so the "latest first" sort in the article index can break
      // ties on entities created in the same second.
      await tx`
        INSERT INTO entities (space_name, source_path, type, kind, label, source_hash, stat_fingerprint, properties, updated_at)
        VALUES (${space.name}, ${relativePath}, 'wiki', 'text', ${label}, ${hash}, ${fingerprint}, ${propsJson}, strftime('%Y-%m-%d %H:%M:%f', 'now'))
      `;
    }

    // Rebuild outbound edges. Wiping + re-inserting is correct because
    // an HTML edit may have added, removed, or rewritten any link. The
    // (source, target) PK with ON CONFLICT IGNORE collapses duplicate
    // anchors to the same target into a single edge.
    await tx`
      DELETE FROM relationships
      WHERE space_name = ${space.name} AND source_path = ${relativePath}
    `;

    for (const link of resolvedLinks) {
      await tx.query(
        `INSERT OR IGNORE INTO relationships (space_name, source_path, target_path, link_text)
         VALUES (?, ?, ?, ?)`,
        [space.name, relativePath, link.resolved, link.text || null],
      );
    }
  });

  return {
    action: existing ? "updated" : "created",
    type: "wiki",
    kind: "text",
    label,
    linksExtracted: resolvedLinks.length,
  };
}

async function syncSource(
  space: Space,
  relativePath: string,
  content: string,
  hash: string,
  fingerprint: string,
  existing: Record<string, unknown> | null,
): Promise<SyncResult> {
  const label = basename(relativePath, extname(relativePath));

  const properties: Record<string, unknown> = {
    file_type: extname(relativePath).slice(1) || "unknown",
  };

  const propsJson = JSON.stringify(properties);
  const sql = createSql();

  if (existing) {
    await sql`
      UPDATE entities
      SET label = ${label},
          source_hash = ${hash},
          stat_fingerprint = ${fingerprint},
          properties = ${propsJson},
          kind = 'text',
          updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
      WHERE space_name = ${space.name} AND source_path = ${relativePath}
    `;
    return { action: "updated", type: "file", kind: "text", label, linksExtracted: 0 };
  }

  await sql`
    INSERT INTO entities (space_name, source_path, type, kind, label, source_hash, stat_fingerprint, properties, updated_at)
    VALUES (${space.name}, ${relativePath}, 'file', 'text', ${label}, ${hash}, ${fingerprint}, ${propsJson}, strftime('%Y-%m-%d %H:%M:%f', 'now'))
  `;
  return { action: "created", type: "file", kind: "text", label, linksExtracted: 0 };
}

/**
 * Sync a binary asset (image, PDF, audio, video, archive, font...).
 *
 * Asset rows exist so `<a href="report.pdf">` and `<img src="chart.png">`
 * inside wikis resolve as real links instead of red links — they're
 * addressable but never enter the agent queues. The kind='text' filter
 * in editor/proposer/connector queue queries excludes them.
 *
 * Called after `syncFile`'s stat-cache miss, so `existing.stat_fingerprint`
 * (if any) does NOT match the current fingerprint — either it's a new
 * row or the file's mtime/size shifted. We compute the real content hash
 * (streaming, so multi-GB videos don't try to fit in RAM); if it matches
 * the stored `source_hash`, the change was a touch — refresh the stat
 * fingerprint and keep everything else.
 *
 * `properties` carries `file_type` and `size_bytes` only — no parsed
 * metadata, no HTML structure, no <a href> link extraction.
 *
 * Asset rows:
 *   - never emit relationships rows (assets don't link to anything);
 *   - never get an entity_edits row (these are typically content the
 *     user dropped on disk, not edits the system performed, and an
 *     edit feed full of "image was added" noise would crowd out the
 *     wiki edits operators actually care about).
 *
 * Asymmetry with `syncWiki`: no `withTransaction` wrapper because the
 * write is a single UPDATE or INSERT (no companion DELETE-and-rebuild
 * of relationships rows). Wrapping would just add a transactional
 * round-trip without affecting consistency.
 */
async function syncAsset(
  space: Space,
  relativePath: string,
  absPath: string,
  stats: { mtimeMs: number; size: number },
  fingerprint: string,
  existing: Record<string, unknown> | null,
): Promise<SyncResult> {
  const label = basename(relativePath, extname(relativePath));
  const sql = createSql();

  const hash = await fileContentHash(absPath);

  // Touch-without-change: stat shifted but bytes didn't. Refresh the
  // cache so the next sync takes the fast path again.
  if (existing && existing.source_hash === hash) {
    await sql`
      UPDATE entities
      SET stat_fingerprint = ${fingerprint}
      WHERE space_name = ${space.name} AND source_path = ${relativePath}
    `;
    return {
      action: "unchanged",
      type: "file",
      kind: "asset",
      label,
      linksExtracted: 0,
    };
  }

  const properties = {
    file_type: extname(relativePath).slice(1).toLowerCase() || "unknown",
    size_bytes: stats.size,
  };
  const propsJson = JSON.stringify(properties);

  if (existing) {
    await sql`
      UPDATE entities
      SET label = ${label},
          source_hash = ${hash},
          stat_fingerprint = ${fingerprint},
          properties = ${propsJson},
          kind = 'asset',
          updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
      WHERE space_name = ${space.name} AND source_path = ${relativePath}
    `;
    return { action: "updated", type: "file", kind: "asset", label, linksExtracted: 0 };
  }

  await sql`
    INSERT INTO entities (space_name, source_path, type, kind, label, source_hash, stat_fingerprint, properties, updated_at)
    VALUES (${space.name}, ${relativePath}, 'file', 'asset', ${label}, ${hash}, ${fingerprint}, ${propsJson}, strftime('%Y-%m-%d %H:%M:%f', 'now'))
  `;
  return { action: "created", type: "file", kind: "asset", label, linksExtracted: 0 };
}

async function recordEntityEdit(
  spaceName: string,
  relativePath: string,
  hash: string,
): Promise<void> {
  const ctx = getEditContext(spaceName, relativePath);
  const byRole = ctx?.role ?? "human";
  const editKind: EditKind = ctx?.edit_kind ?? "resync";
  const note = ctx?.note ?? null;
  const sql = createSql();
  // PK is (space_name, entity_path, at). `at` defaults to strftime('%f')
  // millisecond precision (see 001-foundation.sql), so realistic
  // workflows don't collide. OR IGNORE is the last-line defence for
  // the pathological case of two writes in the same millisecond — the
  // file state is correct regardless; we'd just lose attribution on
  // the second one.
  await sql.query(
    `INSERT OR IGNORE INTO entity_edits
     (space_name, entity_path, by_role, edit_kind, edit_note, content_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [spaceName, relativePath, byRole, editKind, note, hash],
  );
}

/**
 * Remove an entity (and cascade its outbound relationships) when the
 * file disappears from disk. Inbound edges (rows where this path is
 * `target_path`) survive intact — they become red links, since
 * `target_path` has no FK and isn't cascaded. Audit history under
 * this path survives too — the `entity_edits` table is intentionally
 * not FK'd.
 *
 * Returns whether the row existed before deletion.
 */
export async function removeByPath(space: Space, relativePath: string): Promise<boolean> {
  const sql = createSql();
  const rows = await sql`
    DELETE FROM entities
    WHERE space_name = ${space.name} AND source_path = ${relativePath}
    RETURNING source_hash
  `;
  if (rows.length === 0) return false;

  // Audit row for the deletion. We don't know the post-delete content
  // hash (the file is gone), so content_hash stays NULL.
  const ctx = getEditContext(space.name, relativePath);
  const byRole = ctx?.role ?? "human";
  await sql.query(
    `INSERT OR IGNORE INTO entity_edits
     (space_name, entity_path, by_role, edit_kind, edit_note)
     VALUES (?, ?, ?, 'delete', ?)`,
    [space.name, relativePath, byRole, ctx?.note ?? null],
  );
  return true;
}

/**
 * Sync a list of files into the database in a single pass.
 *
 * One pass is sufficient post-rewrite: relationships rows have no FK
 * on target_path (red links are LEFT JOIN'd at query time), so a link
 * to a file that hasn't been synced yet just creates a red-link row
 * that resolves implicitly once the target file syncs.
 *
 * After sync'ing every supplied file, removes any entities whose
 * source_path no longer exists on disk (i.e. files deleted while the
 * watcher was offline). The "exists on disk" check happens at the
 * moment of deletion, NOT against the (stale) `files` snapshot —
 * otherwise any file written between the walk and this cleanup loop
 * (a concurrent applyEdit, a fresh drop by the user, ...) would be
 * mistakenly removed because it isn't in the snapshot.
 */
export async function syncDirectory(
  space: Space,
  files: string[],
): Promise<{ created: number; updated: number; unchanged: number; removed: number }> {
  const summary = { created: 0, updated: 0, unchanged: 0, removed: 0 };

  for (const file of files) {
    try {
      const result = await syncFile(space, file);
      if (result.action === "created") summary.created++;
      else if (result.action === "updated") summary.updated++;
      else if (result.action === "unchanged") summary.unchanged++;
    } catch (err) {
      console.error(`[sync] failed ${file}: ${(err as Error).message}`);
    }
  }

  const sql = createSql();
  const dbEntities = await sql`
    SELECT source_path FROM entities WHERE space_name = ${space.name}
  `;
  for (const row of dbEntities) {
    const p = row.source_path as string;
    const absPath = join(space.watch_dir, p);
    if (!existsSync(absPath)) {
      const removed = await removeByPath(space, p);
      if (removed) summary.removed++;
    }
  }

  return summary;
}
