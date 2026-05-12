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

import { readFileSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { createHash } from "node:crypto";

import { createSql, withTransaction, type SqlClient } from "./sql.js";
import { getEditContext, type EditKind } from "./edit-context.js";
import { parseFrontmatter } from "./frontmatter.js";
import { parseHtmlMeta } from "./html-meta.js";
import { extractHtmlLinks } from "./html-links.js";

export interface Space {
  name: string;
  watch_dir: string;
}

export interface SyncResult {
  action: "created" | "updated" | "unchanged" | "noop";
  type: "wiki" | "file";
  label: string;
  linksExtracted: number;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function isWikiPath(relativePath: string): boolean {
  return relativePath.startsWith("wiki/") && relativePath.endsWith(".html");
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
  const content = readFileSync(absPath, "utf-8");
  const hash = contentHash(content);

  const sql = createSql();
  const existing = await sql`
    SELECT source_hash, type, label
    FROM entities
    WHERE space_name = ${space.name} AND source_path = ${relativePath}
  `;

  if (existing.length > 0 && existing[0].source_hash === hash) {
    return {
      action: "unchanged",
      type: existing[0].type as "wiki" | "file",
      label: existing[0].label as string,
      linksExtracted: 0,
    };
  }

  const result = isWikiPath(relativePath)
    ? await syncWiki(space, relativePath, content, hash, existing[0] ?? null)
    : await syncSource(space, relativePath, content, hash, existing[0] ?? null);

  await recordEntityEdit(space.name, relativePath, hash);

  return result;
}

async function syncWiki(
  space: Space,
  relativePath: string,
  content: string,
  hash: string,
  existing: Record<string, unknown> | null,
): Promise<SyncResult> {
  const meta = parseHtmlMeta(content);
  const label =
    meta.title ??
    (meta.properties.label as string | undefined) ??
    basename(relativePath, ".html");

  const propsJson = JSON.stringify(meta.properties);
  const links = extractHtmlLinks(content, relativePath);
  const resolvedLinks = links.filter((l): l is typeof l & { resolved: string } => l.resolved !== null);

  await withTransaction(async (tx) => {
    if (existing) {
      await tx`
        UPDATE entities
        SET label = ${label},
            source_hash = ${hash},
            properties = ${propsJson},
            updated_at = datetime('now')
        WHERE space_name = ${space.name} AND source_path = ${relativePath}
      `;
    } else {
      await tx`
        INSERT INTO entities (space_name, source_path, type, label, source_hash, properties)
        VALUES (${space.name}, ${relativePath}, 'wiki', ${label}, ${hash}, ${propsJson})
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
    label,
    linksExtracted: resolvedLinks.length,
  };
}

async function syncSource(
  space: Space,
  relativePath: string,
  content: string,
  hash: string,
  existing: Record<string, unknown> | null,
): Promise<SyncResult> {
  const label = basename(relativePath, extname(relativePath));

  // Sources are opaque blobs in the index. Markdown sources get their
  // YAML frontmatter parsed into properties (the Augustine pattern —
  // `book: 5, section: 8`); everything else gets file_type only.
  const properties: Record<string, unknown> = {
    file_type: extname(relativePath).slice(1) || "unknown",
  };
  if (relativePath.endsWith(".md")) {
    try {
      const fm = parseFrontmatter(content);
      Object.assign(properties, fm.properties);
    } catch (err) {
      // Malformed YAML in a source file is recoverable — we still
      // index the file, just without its frontmatter properties.
      console.warn(
        `[sync] malformed frontmatter in ${relativePath}: ${(err as Error).message} — indexing without properties`,
      );
    }
  }

  const propsJson = JSON.stringify(properties);
  const sql = createSql();

  if (existing) {
    await sql`
      UPDATE entities
      SET label = ${label},
          source_hash = ${hash},
          properties = ${propsJson},
          updated_at = datetime('now')
      WHERE space_name = ${space.name} AND source_path = ${relativePath}
    `;
    return { action: "updated", type: "file", label, linksExtracted: 0 };
  }

  await sql`
    INSERT INTO entities (space_name, source_path, type, label, source_hash, properties)
    VALUES (${space.name}, ${relativePath}, 'file', ${label}, ${hash}, ${propsJson})
  `;
  return { action: "created", type: "file", label, linksExtracted: 0 };
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
 * source_path is no longer in the file list (i.e. files deleted while
 * the watcher was offline).
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
  const fileSet = new Set(files);
  for (const row of dbEntities) {
    const p = row.source_path as string;
    if (!fileSet.has(p)) {
      const removed = await removeByPath(space, p);
      if (removed) summary.removed++;
    }
  }

  return summary;
}
