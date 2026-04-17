// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `arkeon rm <files/globs>` — delete document entities and their extracted children.
 *
 * Looks up document entities by source_file property, then cascade-deletes
 * all entities with extracted_from relationships pointing to them.
 */

import type { Command } from "commander";

import { apiGet, apiDelete } from "../../lib/api-client.js";
import { credentials } from "../../lib/credentials.js";
import { output } from "../../lib/output.js";
import { requireRepoState } from "../../lib/repo-state.js";

type EntityResult = {
  id: string;
  properties: Record<string, unknown>;
};

type ListResponse = {
  entities: EntityResult[];
  cursor: string | null;
};

type RelationshipResult = {
  id: string;
  source_id: string;
};

type RelationshipsResponse = {
  relationships: RelationshipResult[];
  cursor: string | null;
};

async function findDocBySourceFile(
  apiUrl: string,
  apiKey: string,
  spaceId: string,
  sourceFile: string,
): Promise<string | null> {
  const filter = `type:document,properties.source_file:${sourceFile}`;
  const resp = await apiGet<ListResponse>(
    apiUrl,
    `/wiki?filter=${encodeURIComponent(filter)}&space_id=${spaceId}&limit=1`,
    apiKey,
  );
  return resp.entities[0]?.id ?? null;
}

/**
 * Check whether an entity has multiple extracted_from sources.
 * We only need to know if there's more than one, so limit=2 suffices.
 *
 * TODO: batch this check — currently called per-child (N+1 pattern).
 * A server-side endpoint that returns source counts would be better.
 */
async function hasMultipleSources(
  apiUrl: string,
  apiKey: string,
  entityId: string,
): Promise<boolean> {
  const resp = await apiGet<RelationshipsResponse>(
    apiUrl,
    `/wiki/${entityId}/relationships?direction=out&predicate=extracted_from&limit=2`,
    apiKey,
  );
  return resp.relationships.length > 1;
}

async function deleteDocumentAndChildren(
  apiUrl: string,
  apiKey: string,
  entityId: string,
): Promise<{ cascaded: number; preserved: number }> {
  let cascaded = 0;
  let preserved = 0;

  let cursor: string | null = null;
  for (;;) {
    const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const resp: RelationshipsResponse = await apiGet<RelationshipsResponse>(
      apiUrl,
      `/wiki/${entityId}/relationships?direction=in&predicate=extracted_from&limit=200${cursorParam}`,
      apiKey,
    );

    for (const rel of resp.relationships) {
      const multiSource = await hasMultipleSources(apiUrl, apiKey, rel.source_id);
      if (multiSource) {
        throw new Error(
          "Cannot remove a document with shared extracted children because direct relationship deletion was removed in the wiki-first API.",
        );
      } else {
        await apiDelete(apiUrl, `/wiki/${rel.source_id}`, apiKey);
        cascaded++;
      }
    }

    cursor = resp.cursor;
    if (!cursor) break;
  }

  await apiDelete(apiUrl, `/wiki/${entityId}`, apiKey);
  return { cascaded, preserved };
}

async function countExtractedChildren(
  apiUrl: string,
  apiKey: string,
  entityId: string,
): Promise<{ wouldDelete: number; wouldPreserve: number }> {
  let wouldDelete = 0;
  let wouldPreserve = 0;
  let cursor: string | null = null;
  for (;;) {
    const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const resp: RelationshipsResponse = await apiGet<RelationshipsResponse>(
      apiUrl,
      `/wiki/${entityId}/relationships?direction=in&predicate=extracted_from&limit=200${cursorParam}`,
      apiKey,
    );
    for (const rel of resp.relationships) {
      const multiSource = await hasMultipleSources(apiUrl, apiKey, rel.source_id);
      if (multiSource) {
        wouldPreserve++;
      } else {
        wouldDelete++;
      }
    }
    cursor = resp.cursor;
    if (!cursor) break;
  }
  return { wouldDelete, wouldPreserve };
}

export function registerRmCommand(program: Command): void {
  program
    .command("rm")
    .description("Delete document entities and their extracted children from the graph")
    .argument("<paths...>", "Source file paths to remove (matches source_file property)")
    .option("--dry-run", "Show what would be deleted without actually deleting")
    .action(async (paths: string[], opts: { dryRun?: boolean }) => {
      try {
        const cwd = process.cwd();
        const state = requireRepoState(cwd);
        const actorId = state.actors.ingestor?.actor_id;
        if (!actorId) throw new Error("No ingestor actor in state. Run `arkeon init` first.");
        const apiKey = credentials.requireActorKey(actorId);
        const dryRun = opts.dryRun ?? false;

        if (dryRun) output.progress("(dry run — no changes will be made)");

        let removedDocs = 0;
        let cascadedEntities = 0;
        let preservedEntities = 0;
        const removed: Array<{ path: string; entity_id: string; cascaded: number; preserved: number }> = [];

        for (const sourcePath of paths) {
          const entityId = await findDocBySourceFile(state.api_url, apiKey, state.space_id, sourcePath);
          if (!entityId) {
            output.warn(`No document entity found for: ${sourcePath}`);
            continue;
          }

          if (dryRun) {
            // Count children without deleting
            const { wouldDelete, wouldPreserve } = await countExtractedChildren(state.api_url, apiKey, entityId);
            const parts = [`would delete ${wouldDelete} extracted entities`];
            if (wouldPreserve > 0) parts.push(`preserve ${wouldPreserve} (multi-source)`);
            output.progress(`  - ${sourcePath} (${entityId}) — ${parts.join(", ")}`);
            removed.push({ path: sourcePath, entity_id: entityId, cascaded: wouldDelete, preserved: wouldPreserve });
            removedDocs++;
            cascadedEntities += wouldDelete;
            preservedEntities += wouldPreserve;
            continue;
          }

          output.progress(`  - ${sourcePath} (${entityId})`);
          const { cascaded, preserved } = await deleteDocumentAndChildren(state.api_url, apiKey, entityId);
          const parts: string[] = [];
          if (cascaded > 0) parts.push(`deleted ${cascaded} extracted entities`);
          if (preserved > 0) parts.push(`preserved ${preserved} (multi-source)`);
          if (parts.length > 0) output.progress(`    (${parts.join(", ")})`);

          removed.push({ path: sourcePath, entity_id: entityId, cascaded, preserved });
          removedDocs++;
          cascadedEntities += cascaded;
          preservedEntities += preserved;
        }

        output.result({
          operation: "rm",
          dry_run: dryRun,
          removed: removedDocs,
          cascaded_entities: cascadedEntities,
          preserved_entities: preservedEntities,
          documents: removed,
        });
      } catch (error) {
        output.error(error, { operation: "rm" });
        process.exitCode = 1;
      }
    });
}
