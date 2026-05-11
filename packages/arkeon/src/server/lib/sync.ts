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
      // Update existing entity. The row may have been a placeholder wiki
      // (source_hash IS NULL) created from a [[wikilink]] in another
      // wiki; writing a real file at this path upgrades it in place. The
      // entity id is preserved so any inbound relationships (the
      // wikilinks that made the placeholder) still resolve to this row.
      // type stays 'wiki' on both sides — appearance of the file on disk
      // is what flips the row from placeholder to fully-realized.
      await tx`
        UPDATE entities
        SET label = ${label},
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
    // create placeholder wikis on miss (source_hash IS NULL, no file on
    // disk yet); standard markdown links must resolve.
    const { resolved: linksResolved, dangling: linksDangling } =
      await rebuildRelationships(tx, space, relativePath, entityId, parsed.body);

    return { linksResolved, linksDangling };
  });

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
 * is deleted from disk. Runs the orphaned-placeholder GC after the cascade
 * so placeholders that were only kept alive by inbound links from the
 * deleted wiki disappear too.
 */
export async function removeByPath(spaceId: string, relativePath: string): Promise<string | null> {
  return withTransaction(async (tx) => {
    const rows = await tx`
      DELETE FROM entities
      WHERE space_id = ${spaceId} AND source_path = ${relativePath}
      RETURNING id
    `;
    if (rows.length === 0) return null;
    await gcOrphanedPlaceholders(tx, spaceId);
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
 *     warning is logged. We do not auto-create placeholders for standard
 *     links — they're treated as typos rather than deliberate "should
 *     exist" markers, since the agent can use `[[Label]]` syntax for that.
 *
 *   - `[[Label]]` and `[[Label|subject_type]]` always produce an edge. The
 *     target path is computed by `wikiPathFor()`; if no entity is at that
 *     path, a placeholder wiki (type='wiki', source_hash=NULL) is inserted
 *     there. Placeholders live until nothing points to them — see
 *     `gcOrphanedPlaceholders()`, which runs at the end of this function.
 *
 *   - When a wikilink resolves to an existing placeholder, its label is
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
): Promise<{ resolved: number; dangling: number; placeholdersCreated: number }> {
  await tx`DELETE FROM relationships WHERE source_id = ${sourceEntityId}`;

  let resolved = 0;
  let dangling = 0;
  let placeholdersCreated = 0;

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
          `Use [[${link.text}]] if you intend to leave a placeholder for it.`,
      );
      dangling++;
    }
  }

  // [[wikilinks]] — resolve or create placeholder.
  //
  // Same-space (no `space:` segment): on miss, insert a placeholder
  // (type='wiki', source_hash IS NULL). syncWikiFile later upgrades the
  // row in place when a real file is written at the same path; the id
  // is preserved so inbound edges survive.
  //
  // Cross-space (`[[Label|t|space:NAME]]`): resolve the named space, then
  // look up `(target_space_id, target_path)`. Cross-space links MUST
  // resolve to an existing wiki — they never create placeholders in the
  // peer space (writes stay scoped to the source's own space; cross-
  // space writes are out of scope, see #99). Unknown space, ambiguous
  // space, or missing target = warn-and-drop, count as dangling.
  const wikilinks = extractWikiLinks(body);
  for (const wl of wikilinks) {
    const targetPath = wikiPathFor(wl.subject_type ?? "concept", wl.label);

    let targetSpaceId: string;
    if (wl.space) {
      // Try id match first (mirrors space-scope.ts:111-121, which is
      // what the agent's `space` tool argument uses). Ids are ULIDs (26
      // alnum chars) — effectively disjoint from human space names, so
      // a string that matches both is a non-issue in practice. The
      // ambiguous-name warning below promises ids work as a fallback;
      // this is what makes that promise true.
      const idMatch = await tx`
        SELECT id FROM spaces WHERE id = ${wl.space}
      `;
      if (idMatch.length === 1) {
        targetSpaceId = idMatch[0].id as string;
      } else {
        const matches = await tx`
          SELECT id FROM spaces WHERE name = ${wl.space}
        `;
        if (matches.length === 0) {
          console.warn(
            `[sync] cross-space wikilink in ${fromPath}: ` +
              `[[${wl.label}|...|space:${wl.space}]] — '${wl.space}' is ` +
              `not registered (neither id nor name). Run 'arkeon-wiki ls' ` +
              `to see registered spaces.`,
          );
          dangling++;
          continue;
        }
        if (matches.length > 1) {
          const ids = matches.map((r) => r.id as string).join(", ");
          console.warn(
            `[sync] cross-space wikilink in ${fromPath}: ` +
              `[[${wl.label}|...|space:${wl.space}]] — name '${wl.space}' is ` +
              `ambiguous (${matches.length} registered spaces share it: ${ids}). ` +
              `Use one of those ids in place of the name.`,
          );
          dangling++;
          continue;
        }
        targetSpaceId = matches[0].id as string;
      }
    } else {
      targetSpaceId = space.id;
    }

    const found = await tx`
      SELECT id, source_hash FROM entities
      WHERE space_id = ${targetSpaceId} AND source_path = ${targetPath}
    `;

    let targetId: string;
    if (found.length > 0) {
      targetId = found[0].id as string;
      // Cross-space wikilinks never rewrite a peer-space row's label —
      // the target lives in another space and is none of our business.
      // Same-space: last-writer-wins on placeholder labels only.
      if (!wl.space && found[0].source_hash === null) {
        await tx`
          UPDATE entities
          SET label = ${wl.label}, updated_at = datetime('now')
          WHERE id = ${targetId}
        `;
      }
    } else if (wl.space) {
      // Cross-space miss: never create a placeholder in the peer space.
      console.warn(
        `[sync] cross-space wikilink in ${fromPath}: ` +
          `[[${wl.label}|...|space:${wl.space}]] — no wiki at ${targetPath} ` +
          `in space '${wl.space}'. Cross-space links must resolve; they ` +
          `do not create placeholders in peer spaces.`,
      );
      dangling++;
      continue;
    } else {
      targetId = generateUlid();
      await tx`
        INSERT INTO entities
          (id, space_id, type, label, source_path, source_hash, properties)
        VALUES
          (${targetId}, ${space.id}, 'wiki', ${wl.label}, ${targetPath}, NULL, '{}')
      `;
      placeholdersCreated++;
    }

    // Preserve the original `[[Label|type]]` (or `[[Label|t|space:NAME]]`)
    // form in `link_path` so downstream consumers can tell a wikilink-
    // derived edge apart from a standard markdown one — and detect
    // cross-space edges via the `space:` substring without re-parsing.
    const linkPath = formatWikilinkPath(wl);
    const relId = generateUlid();
    await tx`
      INSERT INTO relationships (id, source_id, target_id, predicate, link_text, link_path)
      VALUES (${relId}, ${sourceEntityId}, ${targetId}, 'references', ${wl.label}, ${linkPath})
      ON CONFLICT (source_id, target_id, predicate) DO UPDATE
      SET link_text = EXCLUDED.link_text, link_path = EXCLUDED.link_path
    `;
    resolved++;
  }

  await gcOrphanedPlaceholders(tx, space.id);

  return { resolved, dangling, placeholdersCreated };
}

/**
 * Round-trip a parsed wikilink back to its source form for `link_path`.
 * Stable ordering — subject_type before space — so consumers searching
 * for `space:` always find it as a suffix.
 */
function formatWikilinkPath(wl: { label: string; subject_type?: string; space?: string }): string {
  const parts = [wl.label];
  if (wl.subject_type) parts.push(wl.subject_type);
  if (wl.space) parts.push(`space:${wl.space}`);
  return `[[${parts.join("|")}]]`;
}

/**
 * Delete every placeholder wiki in this space (type='wiki' with
 * source_hash IS NULL — i.e. no file on disk yet) whose inbound
 * relationship count has dropped to zero. Runs at the end of
 * `rebuildRelationships()` and after `removeByPath()` deletes — both
 * moments where a relationship row may have just disappeared.
 *
 * **Invariant:** the predicate `(type='wiki' AND source_hash IS NULL)`
 * is the placeholder signal. The only path that produces it today is
 * the [[wikilink]] miss in `rebuildRelationships()` (search the file
 * for the `placeholdersCreated++` site). If a future feature ever
 * nulls `source_hash` for a different reason (e.g. "lock the entity
 * but keep the file"), it MUST add an exclusion clause here so its
 * rows aren't silently GC'd. Pair-with-properties-marker is the
 * obvious next step if that situation arises.
 */
async function gcOrphanedPlaceholders(tx: SqlClient, spaceId: string): Promise<void> {
  // NOT EXISTS with the correlated lookup against `relationships.target_id`
  // is index-driven via `idx_relationships_target` and probes once per
  // placeholder row, bounded by the placeholder count in this space
  // (which the partial index `idx_entities_unresolved` narrows further).
  // The earlier `id NOT IN (SELECT DISTINCT target_id FROM relationships)`
  // form forced a scan of every relationship row across every space on
  // each pass.
  await tx`
    DELETE FROM entities
    WHERE space_id = ${spaceId}
      AND type = 'wiki'
      AND source_hash IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM relationships r WHERE r.target_id = entities.id
      )
  `;
}

/**
 * Resolve links for a single wiki entity. Called during the second pass
 * of syncDirectory() after all entities have been created — this catches
 * standard markdown links whose target was synced after the source. With
 * `[[wikilinks]]`, every link resolves on first pass (placeholder-or-real), so
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
