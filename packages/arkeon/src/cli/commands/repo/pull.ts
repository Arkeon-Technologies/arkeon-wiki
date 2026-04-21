// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon pull` — download wiki entities from the bound space as editable
 * markdown files with YAML frontmatter.
 *
 * Like `git pull`: syncs the local `wiki/` directory with remote entity state.
 * Tracks versions and content hashes in `.arkeon/manifest.json` to detect
 * local modifications, remote updates, and conflicts.
 */

import type { Command } from "commander";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { apiGet } from "../../lib/api-client.js";
import { credentials } from "../../lib/credentials.js";
import {
  contentHash,
  entityToFilePath,
  findByEntityId,
  loadManifest,
  saveManifest,
  type Manifest,
  type ManifestEntry,
} from "../../lib/manifest.js";
import { output } from "../../lib/output.js";
import { requireRepoState } from "../../lib/repo-state.js";
import { serializeEntity } from "../../lib/wiki-serialization.js";

type EntityResult = {
  id: string;
  ver: number;
  kind: string;
  type: string;
  properties: Record<string, unknown>;
};

type ListResponse = {
  entities: EntityResult[];
  cursor: string | null;
};

interface PullOptions {
  force?: boolean;
  dryRun?: boolean;
  filter?: string;
}

/**
 * Fetch all non-relationship entities from the bound space.
 */
async function fetchAllEntities(
  apiUrl: string,
  apiKey: string,
  spaceId: string,
  filter?: string,
): Promise<EntityResult[]> {
  const all: EntityResult[] = [];
  let cursor: string | null = null;

  for (;;) {
    const params = new URLSearchParams({
      space_id: spaceId,
      limit: "200",
    });
    if (cursor) params.set("cursor", cursor);
    if (filter) params.set("filter", filter);

    const resp = await apiGet<ListResponse>(
      apiUrl,
      `/wiki?${params.toString()}`,
      apiKey,
    );

    // The list endpoint already excludes relationships by default (kind!:relationship)
    all.push(...resp.entities);
    cursor = resp.cursor;
    if (!cursor) break;
  }

  return all;
}

export function registerPullCommand(program: Command): void {
  program
    .command("pull")
    .description("Download wiki entities from the bound space as markdown files")
    .option("--force", "Overwrite local changes on conflict")
    .option("--dry-run", "Show what would happen without writing files")
    .option("--filter <filter>", "Filter entities (e.g. properties.subject_type:person)")
    .action(async (opts: PullOptions) => {
      try {
        const cwd = process.cwd();
        const state = requireRepoState(cwd);
        const actorId = state.actors.ingestor?.actor_id;
        if (!actorId) throw new Error("No ingestor actor in state. Run `arkeon init` first.");
        const apiKey = credentials.requireActorKey(actorId);

        output.progress("Fetching entities...");
        const remoteEntities = await fetchAllEntities(
          state.api_url,
          apiKey,
          state.space_id,
          opts.filter,
        );

        const manifest = loadManifest(cwd);
        const remoteById = new Map(remoteEntities.map((e) => [e.id, e]));

        let created = 0;
        let updated = 0;
        let skipped = 0;
        let conflicts = 0;
        let deleted = 0;
        const files: Array<{ path: string; entity_id: string; action: string }> = [];

        // Process each remote entity
        for (const entity of remoteEntities) {
          const existing = findByEntityId(manifest, entity.id);

          if (existing) {
            // Entity already pulled — check for updates
            if (entity.ver === existing.entry.ver) {
              skipped++;
              continue;
            }

            // Remote changed — check for local modifications
            const localPath = join(cwd, existing.path);
            const locallyModified =
              existsSync(localPath) &&
              contentHash(localPath) !== existing.entry.content_hash;

            if (locallyModified && !opts.force) {
              output.warn(`  ! ${existing.path} (conflict: local and remote both changed, use --force to overwrite)`);
              conflicts++;
              continue;
            }

            // Overwrite with remote version
            const filePath = existing.path;
            const content = serializeEntity(entity);

            if (!opts.dryRun) {
              writeFileSync(join(cwd, filePath), content, "utf-8");
              manifest.entries[filePath] = {
                entity_id: entity.id,
                ver: entity.ver,
                content_hash: contentHash(join(cwd, filePath)),
                synced_at: new Date().toISOString(),
              };
            }

            output.progress(`  ~ ${filePath}`);
            files.push({ path: filePath, entity_id: entity.id, action: "updated" });
            updated++;
          } else {
            // New entity — create file
            const filePath = entityToFilePath(entity, manifest);
            const content = serializeEntity(entity);

            if (!opts.dryRun) {
              mkdirSync(join(cwd, dirname(filePath)), { recursive: true });
              writeFileSync(join(cwd, filePath), content, "utf-8");
              manifest.entries[filePath] = {
                entity_id: entity.id,
                ver: entity.ver,
                content_hash: contentHash(join(cwd, filePath)),
                synced_at: new Date().toISOString(),
              };
            }

            output.progress(`  + ${filePath}`);
            files.push({ path: filePath, entity_id: entity.id, action: "created" });
            created++;
          }
        }

        // Detect remotely deleted entities (in manifest but not in remote)
        // Only do this when no filter is applied (filtered pulls are partial)
        if (!opts.filter) {
          for (const [path, entry] of Object.entries(manifest.entries)) {
            if (!remoteById.has(entry.entity_id)) {
              // Safety: only delete files under wiki/ with no traversal
              if (!path.startsWith("wiki/") || path.includes("..")) continue;
              const absPath = join(cwd, path);

              // Check for local modifications before deleting
              const locallyModified =
                existsSync(absPath) &&
                contentHash(absPath) !== entry.content_hash;

              if (locallyModified && !opts.force) {
                output.warn(`  ! ${path} (conflict: locally modified but deleted remotely, use --force to delete)`);
                conflicts++;
                continue;
              }

              if (!opts.dryRun) {
                if (existsSync(absPath)) unlinkSync(absPath);
                delete manifest.entries[path];
              }
              output.progress(`  - ${path} (deleted remotely)`);
              files.push({ path, entity_id: entry.entity_id, action: "deleted" });
              deleted++;
            }
          }
        }

        if (!opts.dryRun) {
          saveManifest(manifest, cwd);
        }

        const summary = [
          created && `${created} created`,
          updated && `${updated} updated`,
          skipped && `${skipped} up-to-date`,
          conflicts && `${conflicts} conflicts`,
          deleted && `${deleted} deleted`,
        ]
          .filter(Boolean)
          .join(", ");

        output.progress(summary || "(nothing to do)");

        output.result({
          operation: "pull",
          created,
          updated,
          skipped,
          conflicts,
          deleted,
          dry_run: opts.dryRun ?? false,
          files,
        });
      } catch (error) {
        output.error(error, { operation: "pull" });
        process.exitCode = 1;
      }
    });
}
