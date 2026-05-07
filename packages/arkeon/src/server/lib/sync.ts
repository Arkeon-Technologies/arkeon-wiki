// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Core sync primitive: bridge files on disk to entities in the database.
 *
 * `syncFile()` is the heart of arkeon-wiki. It reads a file from the
 * filesystem, parses it, and upserts the corresponding entity and
 * relationship edges in the database. Everything else — CLI commands, API
 * routes, file watchers — calls this function.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { createHash } from "node:crypto";

import { createSql, withTransaction, type SqlClient } from "./sql.js";
import { generateUlid } from "./ids.js";
import { getEditContext, type EditKind } from "./edit-context.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import {
  extractMarkdownLinks,
  extractWikiLinks,
  resolveRelativeLink,
} from "./markdown-links.js";
import { wikiPathFor } from "./wiki-paths.js";
import { chunkWiki } from "./chunker.js";
import { enqueueEntity } from "./embedding-queue.js";

// Issue #47 — chunking is on by default. Set ARKEON_WIKI_CHUNKING=0 to
// skip writes to entity_chunks (e.g. for tarball smoke tests that don't
// need the chunker). Read at call time, not module load, so tests and
// CLI flags can flip it after the module is imported.
function chunkingEnabled(): boolean {
  return process.env.ARKEON_WIKI_CHUNKING !== "0";
}

// Issue #47 — embeddings are also on by default but require an embedder
// runtime. The mock fallback exercises the pipeline; for real semantic
// search the user needs Ollama (or wait for the bundled ONNX runtime in
// a follow-up). Set ARKEON_WIKI_EMBEDDINGS=0 to skip the queue entirely.
function embeddingsEnabled(): boolean {
  return process.env.ARKEON_WIKI_EMBEDDINGS !== "0" && chunkingEnabled();
}

export interface Space {
  id: string;
  name: string;
  watch_dir: string;
}

export interface SyncResult {
  entityId: string;
  action: "created" | "updated" | "unchanged";
  label: string;
  type: "wiki" | "file";
  linksResolved: number;
  linksDangling: number;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
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

  // Check if entity already exists
  const sql = createSql();
  const existing = await sql`
    SELECT id, source_hash, type, label
    FROM entities
    WHERE space_id = ${space.id} AND source_path = ${relativePath}
  `;

  if (existing.length > 0 && existing[0].source_hash === hash) {
    return {
      entityId: existing[0].id as string,
      action: "unchanged",
      label: existing[0].label as string,
      type: existing[0].type as "wiki" | "file",
      linksResolved: 0,
      linksDangling: 0,
    };
  }

  // Determine if this is a wiki file (under wiki/ with .md extension)
  const isWiki = relativePath.startsWith("wiki/") && relativePath.endsWith(".md");

  const result = isWiki
    ? await syncWikiFile(space, relativePath, content, hash, existing[0] ?? null)
    : await syncSourceFile(space, relativePath, content, hash, existing[0] ?? null);

  // Record an entity_edits audit row for this change. The edit-context
  // registry tells us who is responsible: a worker that called applyEdit
  // registered its role + edit_kind before writing, and we read that
  // here. Filesystem-driven changes (a human saving in their editor,
  // a watcher reconciling after restart) have no registered context
  // and are attributed to "human" with edit_kind "resync".
  //
  // We re-read the file's hash from disk rather than using the
  // pre-sync hash we computed at the top of syncFile, because
  // syncWikiFile may have rewritten the file (e.g. to inject a
  // generated id into the frontmatter on a brand-new wiki). Using
  // the post-sync hash means the audit row matches the file's final
  // content, so a subsequent watcher resync of the same file finds
  // the (entity_id, content_hash) already recorded and the unique
  // constraint correctly no-ops.
  const finalContent = readFileSync(absPath, "utf-8");
  const finalHash = contentHash(finalContent);
  await recordEntityEdit(space.id, result.entityId, relativePath, finalHash);

  return result;
}

async function recordEntityEdit(
  spaceId: string,
  entityId: string,
  relativePath: string,
  hash: string,
): Promise<void> {
  const ctx = getEditContext(spaceId, relativePath);
  const byRole = ctx?.role ?? "human";
  const editKind: EditKind = ctx?.edit_kind ?? "resync";
  const note = ctx?.note ?? null;
  const sql = createSql();
  await sql`
    INSERT INTO entity_edits (entity_id, by_role, edit_kind, edit_note, content_hash)
    VALUES (${entityId}, ${byRole}, ${editKind}, ${note}, ${hash})
    ON CONFLICT (entity_id, content_hash) DO NOTHING
  `;
}

async function syncWikiFile(
  space: Space,
  relativePath: string,
  content: string,
  hash: string,
  existing: Record<string, unknown> | null,
): Promise<SyncResult> {
  const parsed = parseFrontmatter(content);
  const props = parsed.properties;

  // Extract or generate ID
  let entityId = (props.id as string) ?? existing?.id as string ?? null;
  const isNew = !entityId;
  if (!entityId) {
    entityId = generateUlid();
  }

  // Label is required
  const label = (props.label as string) ?? basename(relativePath, ".md");

  // Build the properties object (everything except id goes into properties JSONB)
  const { id: _id, ...storedProps } = props;
  storedProps.label = label;

  const result = await withTransaction(async (tx) => {
    if (existing) {
      // Update existing entity. Set type='wiki' too: the existing row may
      // be a stub created from a [[wikilink]] in another wiki, and writing
      // a real wiki at this path upgrades it in place. The entity id is
      // preserved so any inbound relationships (the wikilinks that made
      // the stub) still resolve to this row.
      await tx`
        UPDATE entities
        SET type = 'wiki',
            label = ${label},
            source_hash = ${hash},
            properties = ${JSON.stringify(storedProps)},
            updated_at = datetime('now')
        WHERE id = ${entityId}
      `;
    } else {
      // Insert new entity
      await tx`
        INSERT INTO entities (id, space_id, type, label, source_path, source_hash, properties)
        VALUES (${entityId}, ${space.id}, 'wiki', ${label}, ${relativePath}, ${hash}, ${JSON.stringify(storedProps)})
      `;
    }

    // Resolve markdown links + [[wikilinks]] → relationship edges. Wikilinks
    // create stub entities on miss; standard markdown links must resolve.
    const { resolved: linksResolved, dangling: linksDangling } =
      await rebuildRelationships(tx, space, relativePath, entityId, parsed.body);

    if (chunkingEnabled()) {
      const chunks = chunkWiki(parsed, label);

      // Diff-based upsert keyed on (entity_id, content_hash) — keeps
      // chunk_ids stable for unchanged content so entity_embeddings (and
      // therefore chunk_vectors) survive across edits. The plain
      // DELETE+INSERT we used before threw away cascaded pivot rows on
      // every save and forced a full re-embed of the wiki even when only
      // one paragraph changed.
      //
      // The UNIQUE(entity_id, chunk_index) constraint complicates the
      // shuffle when chunks reorder (e.g. a new section inserted between
      // two existing ones bumps every chunk_index after it). Negate every
      // chunk_index first so the positive-integer space is free; then do
      // UPDATEs and INSERTs to the new positive indices; then DELETE any
      // row left at a negative index — that's a chunk no longer present.
      const existingRows = (await tx`
        SELECT id, content_hash
        FROM entity_chunks
        WHERE entity_id = ${entityId}
      `) as Array<{ id: number; content_hash: string }>;

      const existingByHash = new Map<string, number[]>();
      for (const r of existingRows) {
        const ids = existingByHash.get(r.content_hash);
        if (ids) ids.push(r.id);
        else existingByHash.set(r.content_hash, [r.id]);
      }

      await tx`
        UPDATE entity_chunks
        SET chunk_index = -chunk_index - 1
        WHERE entity_id = ${entityId}
      `;

      for (const c of chunks) {
        const candidates = existingByHash.get(c.content_hash);
        if (candidates && candidates.length > 0) {
          const id = candidates.shift()!;
          await tx`
            UPDATE entity_chunks SET
              chunk_index = ${c.chunk_index},
              chunk_kind = ${c.chunk_kind},
              heading_path = ${c.heading_path},
              start_line = ${c.start_line},
              end_line = ${c.end_line},
              text = ${c.text}
            WHERE id = ${id}
          `;
        } else {
          await tx`
            INSERT INTO entity_chunks
              (entity_id, chunk_index, chunk_kind, heading_path,
               start_line, end_line, text, content_hash)
            VALUES (
              ${entityId},
              ${c.chunk_index},
              ${c.chunk_kind},
              ${c.heading_path},
              ${c.start_line},
              ${c.end_line},
              ${c.text},
              ${c.content_hash}
            )
          `;
        }
      }

      // chunk_ids left as un-claimed candidates are about to be deleted.
      // entity_embeddings cascades from entity_chunks; chunk_vectors is a
      // virtual table without FK support so we delete its rows directly.
      // Doing this here (instead of as a periodic worker scan) means the
      // embedder loop never has to do a global LEFT JOIN to find orphans.
      const droppedIds: number[] = [];
      for (const ids of existingByHash.values()) droppedIds.push(...ids);
      for (const id of droppedIds) {
        await tx`DELETE FROM chunk_vectors WHERE chunk_id = ${id}`;
      }

      await tx`
        DELETE FROM entity_chunks
        WHERE entity_id = ${entityId} AND chunk_index < 0
      `;
    }

    return { linksResolved, linksDangling };
  });



  // Hand off to the embedding worker (issue #47). Outside the
  // transaction so a slow embedder can't hold the write lock. The
  // worker re-checks each chunk's content_hash against the pivot
  // before re-embedding, so this is cheap in the no-changes case.
  if (embeddingsEnabled()) {
    try {
      await enqueueEntity(entityId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[sync] failed to enqueue ${entityId} for embedding: ${msg}`,
      );
    }
  }

  // If we generated a new ID, write it back to the file's frontmatter
  if (isNew) {
    const updatedProps = { id: entityId, ...storedProps };
    const updatedContent = serializeFrontmatter(updatedProps, parsed.body);
    const absPath = join(space.watch_dir, relativePath);
    writeFileSync(absPath, updatedContent, "utf-8");

    // Update hash since we changed the file
    const newHash = contentHash(updatedContent);
    const sql = createSql();
    await sql`UPDATE entities SET source_hash = ${newHash} WHERE id = ${entityId}`;
  }

  return {
    entityId,
    action: existing ? "updated" : "created",
    label,
    type: "wiki",
    linksResolved: result.linksResolved,
    linksDangling: result.linksDangling,
  };
}

async function syncSourceFile(
  space: Space,
  relativePath: string,
  _content: string,
  hash: string,
  existing: Record<string, unknown> | null,
): Promise<SyncResult> {
  const label = basename(relativePath, extname(relativePath));
  const entityId = (existing?.id as string) ?? generateUlid();

  const properties: Record<string, unknown> = {
    label,
    file_type: extname(relativePath).slice(1) || "unknown",
    folder: relativePath.includes("/")
      ? relativePath.slice(0, relativePath.lastIndexOf("/"))
      : "",
  };

  const sql = createSql();

  if (existing) {
    await sql`
      UPDATE entities
      SET label = ${label},
          source_hash = ${hash},
          properties = ${JSON.stringify(properties)},
          updated_at = datetime('now')
      WHERE id = ${entityId}
    `;
    return { entityId, action: "updated", label, type: "file", linksResolved: 0, linksDangling: 0 };
  }

  await sql`
    INSERT INTO entities (id, space_id, type, label, source_path, source_hash, properties)
    VALUES (${entityId}, ${space.id}, 'file', ${label}, ${relativePath}, ${hash}, ${JSON.stringify(properties)})
  `;

  return { entityId, action: "created", label, type: "file", linksResolved: 0, linksDangling: 0 };
}

/**
 * Remove an entity and its relationships by source_path. Used when a file
 * is deleted from disk. Runs the orphaned-stub GC after the cascade so
 * stubs that were only kept alive by inbound links from the deleted wiki
 * disappear too.
 */
export async function removeByPath(spaceId: string, relativePath: string): Promise<string | null> {
  return withTransaction(async (tx) => {
    const rows = await tx`
      DELETE FROM entities
      WHERE space_id = ${spaceId} AND source_path = ${relativePath}
      RETURNING id
    `;
    if (rows.length === 0) return null;
    await gcOrphanedStubs(tx, spaceId);
    return rows[0].id as string;
  });
}

/**
 * Rebuild a wiki's outbound relationships from its body. Wipes existing
 * relationships, then walks both standard markdown links and `[[wikilink]]`
 * forms:
 *
 *   - Standard `[text](path.md)` MUST resolve to an existing entity. If
 *     the target path doesn't exist, the relationship is dropped and a
 *     warning is logged. We do not auto-create stubs for standard links —
 *     they're treated as typos rather than deliberate placeholders, since
 *     the agent can use `[[Label]]` syntax for explicit "should-exist" intent.
 *
 *   - `[[Label]]` and `[[Label|subject_type]]` always produce an edge. The
 *     target path is computed by `wikiPathFor()`; if no entity is at that
 *     path, a `type='stub'` entity is inserted there. Stubs created this
 *     way live until nothing points to them — see `gcOrphanedStubs()`,
 *     which runs at the end of this function.
 *
 *   - When a wikilink resolves to an existing stub, the stub's label is
 *     overwritten with the most recent link text (last-writer-wins). The
 *     inbound relationships still carry their own `link_text` so the
 *     pre-overwrite phrasings aren't lost — they're just not the canonical
 *     name anymore.
 */
async function rebuildRelationships(
  tx: SqlClient,
  space: Space,
  fromPath: string,
  sourceEntityId: string,
  body: string,
): Promise<{ resolved: number; dangling: number; stubsCreated: number }> {
  await tx`DELETE FROM relationships WHERE source_id = ${sourceEntityId}`;

  let resolved = 0;
  let dangling = 0;
  let stubsCreated = 0;

  // Standard markdown links — resolve or warn-and-drop.
  const stdLinks = extractMarkdownLinks(body);
  for (const link of stdLinks) {
    const targetPath = resolveRelativeLink(fromPath, link.path);
    const target = await tx`
      SELECT id FROM entities
      WHERE space_id = ${space.id} AND source_path = ${targetPath}
    `;
    if (target.length > 0) {
      const relId = generateUlid();
      await tx`
        INSERT INTO relationships (id, source_id, target_id, predicate, link_text, link_path)
        VALUES (${relId}, ${sourceEntityId}, ${target[0].id}, 'references', ${link.text}, ${link.path})
        ON CONFLICT (source_id, target_id, predicate) DO UPDATE
        SET link_text = EXCLUDED.link_text, link_path = EXCLUDED.link_path
      `;
      resolved++;
    } else {
      console.warn(
        `[sync] dangling link in ${fromPath}: [${link.text}](${link.path}) → ${targetPath} not found. ` +
          `Use [[${link.text}]] if you intend to create a stub for it.`,
      );
      dangling++;
    }
  }

  // [[wikilinks]] — resolve or create stub.
  const wikilinks = extractWikiLinks(body);
  for (const wl of wikilinks) {
    const targetPath = wikiPathFor(wl.subject_type ?? "concept", wl.label);
    const found = await tx`
      SELECT id, type FROM entities
      WHERE space_id = ${space.id} AND source_path = ${targetPath}
    `;

    let targetId: string;
    if (found.length > 0) {
      targetId = found[0].id as string;
      if (found[0].type === "stub") {
        // Last-writer-wins for stub label. Real entities (type='wiki' or
        // 'file') are not touched — their label is set by their own
        // frontmatter, not by what other wikis call them.
        await tx`
          UPDATE entities
          SET label = ${wl.label}, updated_at = datetime('now')
          WHERE id = ${targetId}
        `;
      }
    } else {
      targetId = generateUlid();
      await tx`
        INSERT INTO entities
          (id, space_id, type, label, source_path, source_hash, properties)
        VALUES
          (${targetId}, ${space.id}, 'stub', ${wl.label}, ${targetPath}, NULL, '{}')
      `;
      stubsCreated++;
    }

    // Preserve the original `[[Label|type]]` form in `link_path` so
    // downstream consumers can tell a wikilink-derived edge apart from a
    // standard markdown one.
    const linkPath = wl.subject_type
      ? `[[${wl.label}|${wl.subject_type}]]`
      : `[[${wl.label}]]`;
    const relId = generateUlid();
    await tx`
      INSERT INTO relationships (id, source_id, target_id, predicate, link_text, link_path)
      VALUES (${relId}, ${sourceEntityId}, ${targetId}, 'references', ${wl.label}, ${linkPath})
      ON CONFLICT (source_id, target_id, predicate) DO UPDATE
      SET link_text = EXCLUDED.link_text, link_path = EXCLUDED.link_path
    `;
    resolved++;
  }

  await gcOrphanedStubs(tx, space.id);

  return { resolved, dangling, stubsCreated };
}

/**
 * Delete every stub entity in this space whose inbound relationship count
 * has dropped to zero. Runs at the end of `rebuildRelationships()` and
 * after `removeByPath()` deletes — both moments where a relationship row
 * may have just disappeared.
 */
async function gcOrphanedStubs(tx: SqlClient, spaceId: string): Promise<void> {
  await tx`
    DELETE FROM entities
    WHERE space_id = ${spaceId}
      AND type = 'stub'
      AND id NOT IN (SELECT DISTINCT target_id FROM relationships)
  `;
}

/**
 * Resolve links for a single wiki entity. Called during the second pass
 * of syncDirectory() after all entities have been created — this catches
 * standard markdown links whose target was synced after the source. With
 * `[[wikilinks]]`, every link resolves on first pass (stub-or-real), so
 * pass two is functionally a re-run for cross-reference catch-up.
 */
async function resolveLinks(space: Space, relativePath: string): Promise<{ resolved: number; dangling: number }> {
  const absPath = join(space.watch_dir, relativePath);
  const content = readFileSync(absPath, "utf-8");
  const parsed = parseFrontmatter(content);

  const sql = createSql();
  const rows = await sql`
    SELECT id FROM entities WHERE space_id = ${space.id} AND source_path = ${relativePath}
  `;
  if (rows.length === 0) return { resolved: 0, dangling: 0 };
  const entityId = rows[0].id as string;

  return withTransaction(async (tx) => {
    const { resolved, dangling } = await rebuildRelationships(
      tx,
      space,
      relativePath,
      entityId,
      parsed.body,
    );
    return { resolved, dangling };
  });
}

/**
 * Sync an entire directory by walking all files and calling syncFile().
 *
 * Two passes:
 *   1. Create/update all entities (links may dangle if targets don't exist yet)
 *   2. Re-resolve all wiki links (now that all entities exist)
 *
 * Returns a summary of actions taken.
 */
export async function syncDirectory(
  space: Space,
  files: string[],
): Promise<{ created: number; updated: number; unchanged: number; removed: number }> {
  const summary = { created: 0, updated: 0, unchanged: 0, removed: 0 };

  // Pass 1: create/update all entities
  for (const file of files) {
    const result = await syncFile(space, file);
    summary[result.action]++;
  }

  // Pass 2: re-resolve links for all wiki files (now all targets exist)
  const wikiFiles = files.filter((f) => f.startsWith("wiki/") && f.endsWith(".md"));
  for (const file of wikiFiles) {
    await resolveLinks(space, file);
  }

  // Find entities in the database that no longer exist on disk
  const sql = createSql();
  const dbEntities = await sql`
    SELECT id, source_path FROM entities WHERE space_id = ${space.id}
  `;

  const fileSet = new Set(files);
  for (const entity of dbEntities) {
    if (!fileSet.has(entity.source_path as string)) {
      await removeByPath(space.id, entity.source_path as string);
      summary.removed++;
    }
  }

  return summary;
}
