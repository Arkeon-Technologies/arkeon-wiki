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

import { createSql, withTransaction } from "./sql.js";
import { generateUlid } from "./ids.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { extractMarkdownLinks, resolveRelativeLink } from "./markdown-links.js";
import { chunkWiki } from "./chunker.js";

// Issue #47 — opt-in until the embedder + vec0 index land. Setting
// ARKEON_WIKI_CHUNKING=1 makes syncWikiFile populate entity_chunks.
// Read at call time, not module load, so tests and CLI flags can flip
// it after the module is imported.
function chunkingEnabled(): boolean {
  return process.env.ARKEON_WIKI_CHUNKING === "1";
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

  if (isWiki) {
    return syncWikiFile(space, relativePath, content, hash, existing[0] ?? null);
  } else {
    return syncSourceFile(space, relativePath, content, hash, existing[0] ?? null);
  }
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
      // Update existing entity
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

    // Resolve markdown links → relationship edges
    const links = extractMarkdownLinks(parsed.body);

    // Delete existing relationships from this entity (we'll re-create them)
    await tx`DELETE FROM relationships WHERE source_id = ${entityId}`;

    let linksResolved = 0;
    let linksDangling = 0;

    for (const link of links) {
      const targetPath = resolveRelativeLink(relativePath, link.path);

      // Look up target entity by source_path
      const target = await tx`
        SELECT id FROM entities
        WHERE space_id = ${space.id} AND source_path = ${targetPath}
      `;

      if (target.length > 0) {
        const relId = generateUlid();
        await tx`
          INSERT INTO relationships (id, source_id, target_id, predicate, link_text, link_path)
          VALUES (${relId}, ${entityId}, ${target[0].id}, 'references', ${link.text}, ${link.path})
          ON CONFLICT (source_id, target_id, predicate) DO UPDATE
          SET link_text = EXCLUDED.link_text, link_path = EXCLUDED.link_path
        `;
        linksResolved++;
      } else {
        linksDangling++;
      }
    }

    if (chunkingEnabled()) {
      const chunks = chunkWiki(parsed, label);
      await tx`DELETE FROM entity_chunks WHERE entity_id = ${entityId}`;
      for (const c of chunks) {
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
 * Remove an entity and its relationships by source_path.
 * Used when a file is deleted from disk.
 */
export async function removeByPath(spaceId: string, relativePath: string): Promise<string | null> {
  const sql = createSql();
  const rows = await sql`
    DELETE FROM entities
    WHERE space_id = ${spaceId} AND source_path = ${relativePath}
    RETURNING id
  `;
  return rows.length > 0 ? (rows[0].id as string) : null;
}

/**
 * Resolve links for a single wiki entity. Called during the second pass
 * of syncDirectory() after all entities have been created.
 */
async function resolveLinks(space: Space, relativePath: string): Promise<{ resolved: number; dangling: number }> {
  const absPath = join(space.watch_dir, relativePath);
  const content = readFileSync(absPath, "utf-8");
  const parsed = parseFrontmatter(content);
  const links = extractMarkdownLinks(parsed.body);

  if (links.length === 0) return { resolved: 0, dangling: 0 };

  const sql = createSql();

  // Look up the entity ID for this file
  const rows = await sql`
    SELECT id FROM entities WHERE space_id = ${space.id} AND source_path = ${relativePath}
  `;
  if (rows.length === 0) return { resolved: 0, dangling: 0 };
  const entityId = rows[0].id as string;

  return withTransaction(async (tx) => {
    // Clear existing relationships and re-resolve
    await tx`DELETE FROM relationships WHERE source_id = ${entityId}`;

    let resolved = 0;
    let dangling = 0;

    for (const link of links) {
      const targetPath = resolveRelativeLink(relativePath, link.path);
      const target = await tx`
        SELECT id FROM entities WHERE space_id = ${space.id} AND source_path = ${targetPath}
      `;

      if (target.length > 0) {
        const relId = generateUlid();
        await tx`
          INSERT INTO relationships (id, source_id, target_id, predicate, link_text, link_path)
          VALUES (${relId}, ${entityId}, ${target[0].id}, 'references', ${link.text}, ${link.path})
          ON CONFLICT (source_id, target_id, predicate) DO UPDATE
          SET link_text = EXCLUDED.link_text, link_path = EXCLUDED.link_path
        `;
        resolved++;
      } else {
        dangling++;
      }
    }

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
