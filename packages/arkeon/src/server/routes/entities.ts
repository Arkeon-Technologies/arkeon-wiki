// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createRoute, z } from "@hono/zod-openapi";

import { backgroundTask } from "../lib/background";
import { deepMergeObjects } from "../lib/properties";
import { encodeCursor } from "../lib/cursor";
import { parseProjection, projectEntity } from "../lib/entity-projection";
import {
  assertBodyObject,
  addEntityToSpaceQuery,
  type EntityRecord,
} from "../lib/entities";
import { ApiError } from "../lib/errors";
import {
  requireActor,
  parseCursorParam,
  parseJsonBody,
  parseLimit,
} from "../lib/http";
import { generateUlid } from "../lib/ids";
import { buildEntityFilterWhere, buildEntityListingQuery, mergeFilters, parseOrder, parseSort } from "../lib/listing";
import { indexEntity, indexEntityById, removeEntities, removeEntity } from "../lib/meilisearch";
import { fetchRelationshipContext } from "../lib/relationship-context";
import { createRouter } from "../lib/openapi";
import {
  ExpandedEntitySchema,
  PageEntitySchema,
  DateTimeSchema,
  EntityIdParam,
  EntityResponse,
  EntitySchema,
  ProjectionQuery,
  UlidSchema,
  cursorResponseSchema,
  entityIdParams,
  errorResponses,
  filterQuerySchema,
  jsonContent,
  paginationQuerySchema,
  pathParam,
  queryParam,
} from "../lib/schemas";
import { setActorContext } from "../lib/actor-context";
import { createSql } from "../lib/sql";
import {
  processWikiContent,
  fetchWikiReferences,
  diffWikiReferences,
  applyRelationshipDiff,
} from "../lib/wiki-pipeline";

type VersionRow = {
  entity_id?: string;
  ver: number;
  properties?: Record<string, unknown>;
  edited_by: string;
  note: string | null;
  created_at: string;
};

const VersionSchema = z.object({
  entity_id: EntityIdParam.optional(),
  ver: z.number().int(),
  properties: z.record(z.string(), z.any()).optional(),
  edited_by: EntityIdParam,
  note: z.string().nullable(),
  created_at: DateTimeSchema,
});

// --- Route definitions ---

const ListEntitiesQuery = filterQuerySchema(["updated_at", "created_at"], "updated_at")
  .merge(ProjectionQuery)
  .merge(paginationQuerySchema(50, 200))
  .merge(z.object({
    space_id: queryParam("space_id", z.string().optional(), "Scope results to a space ULID"),
  }));

const listEntitiesRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listWikis",
  tags: ["Wiki"],
  summary: "List entities with filtering, sorting, and cursor pagination",
  "x-arke-auth": "optional",
  "x-arke-related": ["GET /search", "GET /wiki/{id}"],
  "x-arke-rules": [
    "If space_id is provided, only entities belonging to that space are returned",
  ],
  request: {
    query: ListEntitiesQuery,
  },
  responses: {
    200: {
      description: "Paginated entity list",
      content: jsonContent(cursorResponseSchema("entities", EntitySchema)),
    },
    ...errorResponses([400, 403]),
  },
});

const getEntityRoute = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getWiki",
  tags: ["Wiki"],
  summary: "Fetch a single entity by ID",
  description:
    "Defaults to view=page, which returns a structured response with links_to, linked_from, and sources — everything needed to render a wiki page. " +
    "Use view=expanded for a flat _relationships array, or view=full for the entity without relationships. " +
    "Control the number of relationships with rel_limit (default 20 for expanded, 50 for page, max 200). " +
    "Check relationships_truncated to know if more exist; use GET /wiki/{id}/relationships for the full paginated set.",
  "x-arke-auth": "optional",
  "x-arke-related": [
    "PUT /wiki/{id}",
    "GET /wiki/{id}/versions",
  ],
  "x-arke-rules": ["Returns 404 if entity does not exist"],
  request: {
    params: entityIdParams(),
    query: z.object({
      view: queryParam(
        "view",
        z.enum(["full", "summary", "expanded", "page"]).optional(),
        "Projection (default: page). page returns structured links_to/linked_from/sources. expanded adds flat _relationships. full returns entity only. summary returns label + short_description.",
      ),
      fields: queryParam("fields", z.string().optional(), "Comma-separated field list"),
      rel_limit: queryParam(
        "rel_limit",
        z.coerce.number().int().min(1).max(200).optional(),
        "Max relationships when view=expanded (default 20) or view=page (default 50). Max 200.",
      ),
    }),
  },
  responses: {
    200: {
      description: "Entity details. When view=expanded, includes _relationships and _relationships_truncated. When view=page, returns structured links_to/linked_from/sources.",
      content: jsonContent(z.union([
        z.object({ wiki: z.union([EntitySchema, ExpandedEntitySchema]) }),
        PageEntitySchema,
      ])),
    },
    304: { description: "Not modified" },
    ...errorResponses([400, 404]),
    410: { description: "Entity was merged into another entity" },
  },
});

const updateEntityRoute = createRoute({
  method: "put",
  path: "/{id}",
  operationId: "updateWiki",
  tags: ["Wiki"],
  summary: "Update entity properties",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /wiki/{id}", "GET /wiki/{id}/versions"],
  "x-arke-rules": ["Only the owner or an admin may update", "Optimistic concurrency: must pass current ver to update", "Properties are shallow-merged: only provided keys are updated, omitted keys are preserved", "remove_properties deletes keys by name after the merge, so removals take precedence over additions", "When properties.content is updated on a wiki, typed [[links]] are parsed and resolved — new placeholders are minted, relationships are created/updated/removed, and [[assign:...]] links are queued for background drafting"],
  request: {
    params: entityIdParams(),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          ver: z.number().int().describe("Expected current version (CAS token)"),
          properties: z.record(z.string(), z.any()).optional(),
          remove_properties: z.array(z.string()).optional().describe("Property keys to delete from the entity. Applied after the properties merge, so removals take precedence."),
          note: z.string().optional(),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Entity updated. When content contains wiki links that were processed, includes placeholders, relationships_created, and resolve_warnings.",
      content: jsonContent(z.object({
        wiki: EntitySchema,
        placeholders: z.array(
          z.object({
            id: EntityIdParam,
            label: z.string(),
            status: z.enum(["placeholder", "assigned"]),
          }),
        ).optional().describe("Placeholders minted from wiki links in updated content. Only present when content was processed through the wiki link pipeline."),
        relationships_created: z.number().int().optional().describe("Number of new reference relationships created. Only present when content was processed."),
        relationships_updated: z.number().int().optional().describe("Number of existing reference relationships updated (span_text changed). Only present when content was processed."),
        relationships_removed: z.number().int().optional().describe("Number of reference relationships removed (target no longer in content). Only present when content was processed."),
        resolve_warnings: z.array(
          z.object({
            label: z.string(),
            reason: z.enum(["llm_not_configured", "no_match"]),
          }),
        ).optional().describe("Emitted when [[resolve:...]] links soft-degrade to placeholders."),
      })),
    },
    ...errorResponses([400, 401, 403, 404, 409]),
  },
});

const deleteEntityRoute = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "deleteWiki",
  tags: ["Wiki"],
  summary: "Delete an entity",
  "x-arke-auth": "required",
  "x-arke-rules": ["Only the owner or an admin may delete"],
  request: { params: entityIdParams() },
  responses: {
    204: { description: "Entity deleted" },
    ...errorResponses([401, 403, 404]),
  },
});

const BULK_DELETE_LIMIT = 1000;

const BulkDeleteQuery = z.object({
  filter: queryParam("filter", z.string().optional(), "Column/property filters. See GET /help for filter syntax."),
  space_id: queryParam("space_id", z.string().optional(), "Delete all entities in this space ULID"),
});

const bulkDeleteEntitiesRoute = createRoute({
  method: "delete",
  path: "/",
  operationId: "bulkDeleteWikis",
  tags: ["Wiki"],
  summary: "Bulk delete entities matching filter and/or space",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /wiki", "DELETE /wiki/{id}"],
  "x-arke-rules": [
    "Requires at least one of filter or space_id",
    "Capped at 1000 entities per call — returns 400 if more match",
    "RLS enforces per-entity permission checks — only entities you can delete are deleted",
    "Relationships are excluded unless explicitly filtered by kind",
  ],
  request: { query: BulkDeleteQuery },
  responses: {
    200: {
      description: "Bulk delete result",
      content: jsonContent(z.object({
        deleted: z.number().int(),
        ids: z.array(z.string()),
      })),
    },
    ...errorResponses([400, 401, 403]),
  },
});

const listVersionsRoute = createRoute({
  method: "get",
  path: "/{id}/versions",
  operationId: "listWikiVersions",
  tags: ["Wiki"],
  summary: "List version history",
  "x-arke-auth": "optional",
  "x-arke-rules": [],
  request: {
    params: entityIdParams(),
    query: paginationQuerySchema(50, 200),
  },
  responses: {
    200: {
      description: "Version history",
      content: jsonContent(cursorResponseSchema("versions", VersionSchema)),
    },
    ...errorResponses([400, 404]),
  },
});

const mergeEntityRoute = createRoute({
  method: "post",
  path: "/{id}/merge",
  operationId: "mergeWiki",
  tags: ["Wiki"],
  summary: "Merge a source entity into this entity",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /wiki/{id}", "DELETE /wiki/{id}"],
  "x-arke-rules": [
    "Both entities must have the same kind (entity or relationship)",
    "If merging relationships, both must connect the same source and target entities",
    "Source entity is deleted after merge; a redirect is created from source ID to target ID",
  ],
  request: {
    params: entityIdParams(),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          source_id: EntityIdParam.describe("Entity ULID to merge FROM (will be deleted)"),
          property_strategy: z.enum(["keep_target", "keep_source", "shallow_merge", "accumulate"]).default("keep_source")
            .describe("How to merge properties: keep_target, keep_source (default), shallow_merge (source wins conflicts), or accumulate (never drops info)"),
          ver: z.number().int().describe("Expected current version of the target entity (CAS token)"),
          note: z.string().optional().describe("Optional version note for the merge"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Entity merged successfully",
      content: jsonContent(EntityResponse),
    },
    ...errorResponses([400, 401, 403, 404, 409]),
  },
});

const getVersionRoute = createRoute({
  method: "get",
  path: "/{id}/versions/{ver}",
  operationId: "getWikiVersion",
  tags: ["Wiki"],
  summary: "Get a specific version snapshot",
  "x-arke-auth": "optional",
  "x-arke-rules": [],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Entity ULID"),
      ver: pathParam("ver", z.coerce.number().int().min(1), "Version number"),
    }),
  },
  responses: {
    200: {
      description: "Version snapshot",
      content: jsonContent(VersionSchema.extend({ entity_id: EntityIdParam })),
    },
    ...errorResponses([400, 404]),
  },
});

const mergeBatchRoute = createRoute({
  method: "post",
  path: "/merge-batch",
  operationId: "mergeBatchWikis",
  tags: ["Wiki"],
  summary: "Merge multiple groups of duplicate entities in a single request",
  description:
    "Each group contains entity IDs that should be merged into one. " +
    "The entity with the richest properties is auto-selected as the merge target. " +
    "Groups are processed concurrently; partial success is possible.",
  "x-arke-auth": "required",
  "x-arke-related": ["POST /wiki/{id}/merge", "POST /wiki/bulk"],
  "x-arke-rules": [
    "All entities in a group must have the same kind (entity or relationship)",
    "Entity with richest properties is auto-selected as merge target",
    "Maximum 100 groups per request, 500 entities per group",
    "An entity ID must not appear in more than one group",
  ],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          groups: z.array(
            z.object({
              entity_ids: z.array(EntityIdParam).min(2).max(500)
                .describe("Entity ULIDs to merge into one (min 2, max 500)"),
            }),
          ).min(1).max(100).describe("Groups of duplicate entities to merge"),
          property_strategy: z.enum(["keep_target", "keep_source", "shallow_merge", "accumulate"]).default("accumulate")
            .describe("How to merge properties: accumulate (default, never drops info), shallow_merge (source wins), keep_target, keep_source"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Batch merge results (partial success possible)",
      content: jsonContent(
        z.object({
          merged: z.number().int().describe("Total entities successfully merged"),
          failed: z.number().int().describe("Total groups that failed"),
          groups: z.array(
            z.object({
              target_id: EntityIdParam.describe("Entity chosen as merge target"),
              merged_count: z.number().int().describe("Number of sources merged into target"),
              final_ver: z.number().int().describe("Target version after all merges"),
              error: z.string().nullable().describe("Error message if group failed"),
            }),
          ),
        }),
      ),
    },
    ...errorResponses([400, 401, 403]),
  },
});

const bulkGetEntitiesRoute = createRoute({
  method: "post",
  path: "/bulk",
  operationId: "bulkGetWikis",
  tags: ["Wiki"],
  summary: "Fetch multiple entities by ID in one request",
  description:
    "Accepts up to 100 entity IDs and returns them in the requested order. " +
    "Entities hidden by RLS are silently omitted. " +
    "Use view=expanded to include relationships with counterpart summaries.",
  "x-arke-auth": "optional",
  "x-arke-related": ["GET /wiki/{id}", "GET /search"],
  "x-arke-rules": [],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          ids: z.array(UlidSchema).min(1).max(100).describe("Entity ULIDs to fetch (max 100)"),
        }),
      ),
    },
    query: z.object({
      view: queryParam(
        "view",
        z.enum(["full", "summary", "expanded"]).optional(),
        "Projection: full (default, all fields) | summary (label + short_description) | expanded (all fields + _relationships).",
      ),
      fields: queryParam("fields", z.string().optional(), "Comma-separated field list"),
      rel_limit: queryParam(
        "rel_limit",
        z.coerce.number().int().min(1).max(100).optional(),
        "Max relationships per entity when view=expanded (default 20, max 100)",
      ),
    }),
  },
  responses: {
    200: {
      description: "Entities in requested order (missing/hidden entities omitted). When view=expanded, each entity includes _relationships and _relationships_truncated.",
      content: jsonContent(
        z.object({
          entities: z.array(z.union([EntitySchema, ExpandedEntitySchema])),
        }),
      ),
    },
    ...errorResponses([400]),
  },
});

// --- Handlers ---

export const wikisRouter = createRouter();

wikisRouter.openapi(listEntitiesRoute, async (c) => {
  const sql = createSql();
  const actorCtx = c.get("actor");
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const projection = parseProjection(c.req.query("view"), c.req.query("fields"));
  const cursor = parseCursorParam(c);
  const order = parseOrder(c.req.query("order"));
  const sort = parseSort(c.req.query("sort"), ["updated_at", "created_at"], "updated_at");

  const userFilter = c.req.query("filter");
  const hasKindFilter = userFilter?.split(",").some((expr) => /^kind(!:|!\?|>=|<=|>|<|:|\?)/.test(expr.trim()));
  const implicitFilter = hasKindFilter ? undefined : "kind!:relationship";
  const filter = implicitFilter ? mergeFilters(implicitFilter, userFilter) : userFilter;

  const spaceId = c.req.query("space_id");
  const listing = buildEntityListingQuery({ filter, limit, cursor, sort, order, spaceId });

  const txResults = await sql.transaction([
    ...setActorContext(sql, actorCtx),
    sql.query(listing.query, listing.params),
  ]);
  const rows = txResults[txResults.length - 1] as Array<Record<string, unknown>>;
  const entities = rows.slice(0, limit);
  const next = rows.length > limit ? entities[entities.length - 1] : null;

  return c.json({
    entities: entities.map((row) => projectEntity(row, projection)),
    cursor: next ? encodeCursor({ t: (next[sort] ?? next.updated_at) as string | Date, i: String(next.id) }) : null,
  }, 200);
});

wikisRouter.openapi(getEntityRoute, async (c) => {
  const actor = c.get("actor");
  const projection = parseProjection(c.req.query("view") ?? "page", c.req.query("fields"));
  const entityId = c.req.param("id");
  const sql = createSql();

  // Simple SELECT — actor context is set for any future RLS needs
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`SELECT e.*,
      (SELECT COALESCE(array_agg(se.space_id), '{}') FROM space_entities se WHERE se.entity_id = e.id) AS space_ids
      FROM entities e WHERE e.id = ${entityId} LIMIT 1`,
  ]);

  const entity = (results[results.length - 1] as EntityRecord[])[0];
  if (!entity) {
    // Check if entity was merged into another
    const redirectRows = await sql`SELECT new_id, merged_at FROM entity_redirects WHERE old_id = ${entityId} LIMIT 1`;
    const redirect = (redirectRows as Array<{ new_id: string; merged_at: string }>)[0];
    if (redirect) {
      throw new ApiError(410, "entity_merged", "This entity was merged into another entity", {
        merged_into: redirect.new_id,
        merged_at: redirect.merged_at,
      });
    }
    throw new ApiError(404, "not_found", "Entity not found");
  }

  const ifNoneMatch = c.req.header("if-none-match")?.replaceAll("\"", "");
  if (ifNoneMatch && ifNoneMatch === String(entity.ver)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: `"${entity.ver}"` },
    });
  }

  c.header("etag", `"${entity.ver}"`);

  if (projection.view === "expanded") {
    const relLimit = Math.min(Number(c.req.query("rel_limit")) || 20, 200);
    const relMap = await fetchRelationshipContext(sql, actor, [entityId], relLimit);
    const ctx = relMap.get(entityId);
    return c.json({
      wiki: {
        ...projectEntity(entity, { view: "full", fields: null }),
        _relationships: ctx?.items ?? [],
        _relationships_truncated: ctx?.truncated ?? false,
      },
    }, 200);
  }

  if (projection.view === "page") {
    const relLimit = Math.min(Number(c.req.query("rel_limit")) || 50, 200);
    const relMap = await fetchRelationshipContext(sql, actor, [entityId], relLimit);
    const ctx = relMap.get(entityId);
    const items = ctx?.items ?? [];

    const links_to: Array<{ id: string; label: string | null; type: string; predicate: string; span_text: string | null }> = [];
    const linked_from: typeof links_to = [];
    const sources: Array<{ id: string; label: string | null }> = [];

    for (const rel of items) {
      if (rel.counterpart.type === "source") {
        sources.push({
          id: rel.counterpart.id,
          label: rel.counterpart.properties.label,
        });
        continue;
      }

      const entry = {
        id: rel.counterpart.id,
        label: rel.counterpart.properties.label,
        type: rel.counterpart.type,
        predicate: rel.predicate,
        span_text: (rel.properties.span_text as string) ?? null,
      };

      if (rel.direction === "out") {
        links_to.push(entry);
      } else {
        linked_from.push(entry);
      }
    }

    return c.json({
      wiki: projectEntity(entity, { view: "full", fields: null }),
      links_to,
      linked_from,
      sources,
      relationships_truncated: ctx?.truncated ?? false,
    }, 200);
  }

  return c.json({ wiki: projectEntity(entity, projection) }, 200);
});

wikisRouter.openapi(updateEntityRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const expectedVer = typeof body.ver === "number" ? body.ver : null;
  if (expectedVer === null) {
    throw new ApiError(400, "missing_required_field", "Missing ver");
  }

  const properties = body.properties === undefined
    ? undefined
    : assertBodyObject(body.properties, "properties");
  const removeProperties = Array.isArray(body.remove_properties)
    ? (body.remove_properties as string[]).filter((k) => typeof k === "string" && k.length > 0)
    : [];
  const note = body.note === undefined ? null : typeof body.note === "string" ? body.note : null;

  if (!properties && removeProperties.length === 0) {
    throw new ApiError(400, "invalid_body", "No changes requested");
  }

  const sql = createSql();
  const now = new Date().toISOString();

  // Detect if content is being updated — triggers the wiki link pipeline
  const newContent = properties?.content;
  const hasContentUpdate = typeof newContent === "string" && newContent.length > 0;

  let pipelineResult: Awaited<ReturnType<typeof processWikiContent>> | null = null;
  let mergeProperties = properties;
  let pipelineSpaceId: string | null = null;

  if (hasContentUpdate) {
    // Fetch current entity to check if content actually changed and get space_id
    const currentRows = await sql.transaction([
      ...setActorContext(sql, actor),
      sql`SELECT properties FROM entities WHERE id = ${entityId} AND type = 'wiki' LIMIT 1`,
    ]);
    const currentEntity = (currentRows[currentRows.length - 1] as Array<{ properties: Record<string, unknown> }>)[0];
    const currentContent = currentEntity?.properties?.content;

    if (currentContent !== newContent) {
      // Look up which space this wiki belongs to
      const spTxResults = await sql.transaction([
        ...setActorContext(sql, actor),
        sql`SELECT space_id FROM space_entities WHERE entity_id = ${entityId} LIMIT 1`,
      ]);
      const spaceRows = spTxResults[spTxResults.length - 1] as Array<{ space_id: string }>;
      pipelineSpaceId = (spaceRows[0]?.space_id as string) ?? null;
      if (!pipelineSpaceId) {
        throw new ApiError(500, "internal_error", "Wiki has no space assignment");
      }

      // Run the wiki link pipeline on the new content
      pipelineResult = await processWikiContent({
        actor,
        spaceId: pipelineSpaceId,
        content: newContent,
        depth: 0,
        maxDepth: 2,
      });

      // Rewrite the properties to use resolved content + store submitted_content
      mergeProperties = {
        ...properties,
        submitted_content: newContent,
        content: pipelineResult.resolvedContent,
      };
    }
  }

  // Build the properties expression:
  //   merge only:  properties || $merge
  //   remove only: properties - $keys
  //   both:        (properties || $merge) - $keys  (removals win)
  const hasMerge = mergeProperties && Object.keys(mergeProperties).length > 0;
  const hasRemove = removeProperties.length > 0;
  let propsExpr: string;
  const params: unknown[] = [];
  let paramIdx = 1;

  if (hasMerge && hasRemove) {
    propsExpr = `(properties || $${paramIdx}::jsonb) - $${paramIdx + 1}::text[]`;
    params.push(JSON.stringify(mergeProperties), removeProperties);
    paramIdx += 2;
  } else if (hasMerge) {
    propsExpr = `properties || $${paramIdx}::jsonb`;
    params.push(JSON.stringify(mergeProperties));
    paramIdx += 1;
  } else {
    propsExpr = `properties - $${paramIdx}::text[]`;
    params.push(removeProperties);
    paramIdx += 1;
  }

  // Remaining params: edited_by, note, updated_at, id, ver
  const editedByIdx = paramIdx;
  const noteIdx = paramIdx + 1;
  const nowIdx = paramIdx + 2;
  const idIdx = paramIdx + 3;
  const verIdx = paramIdx + 4;
  params.push(actor.id, note, now, entityId, expectedVer);

  // Actor context set for ownership checks
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `UPDATE entities
       SET properties = ${propsExpr},
           ver = ver + 1,
           edited_by = $${editedByIdx},
           note = $${noteIdx},
           updated_at = $${nowIdx}::timestamptz
       WHERE id = $${idIdx} AND ver = $${verIdx}
       RETURNING *`,
      params,
    ),
  ]);

  const updated = (results[results.length - 1] as EntityRecord[])[0];
  if (!updated) {
    // Distinguish CAS conflict from permission denial
    const existsResult = await sql.transaction([
      ...setActorContext(sql, actor),
      sql`SELECT ver FROM entities WHERE id = ${entityId} LIMIT 1`,
    ]);
    const fresh = (existsResult[existsResult.length - 1] as Array<{ ver: number }>)[0];
    if (fresh) {
      if (fresh.ver !== expectedVer) {
        throw new ApiError(409, "cas_conflict", "Version mismatch", {
          entity_id: entityId,
          expected_ver: expectedVer,
        });
      }
      throw new ApiError(403, "forbidden", "You do not have write access on this entity");
    }
    throw new ApiError(404, "not_found", "Entity not found");
  }

  // Version snapshot
  backgroundTask(
    sql.transaction([
      ...setActorContext(sql, actor),
      sql.query(
        `INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6::timestamptz)`,
        [entityId, updated.ver, JSON.stringify(updated.properties), actor.id, note, now],
      ),
    ]).then(() => undefined).catch(console.error),
  );
  backgroundTask(indexEntity(updated));

  // If content was processed through the pipeline, diff and apply relationship changes
  if (pipelineResult && pipelineSpaceId) {
    const existingRefs = await fetchWikiReferences(actor, entityId);
    const diff = diffWikiReferences(existingRefs, pipelineResult.targets);
    const relResult = await applyRelationshipDiff({
      actor,
      wikiId: entityId,
      spaceId: pipelineSpaceId,
      diff,
      now,
    });

    // Remove deleted relationship entities from Meilisearch
    if (relResult.deleted.length > 0) {
      backgroundTask(removeEntities(relResult.deleted));
    }

    return c.json({
      wiki: updated,
      placeholders: pipelineResult.placeholders,
      relationships_created: relResult.created,
      relationships_updated: relResult.updated,
      relationships_removed: relResult.deleted.length,
      ...(pipelineResult.resolveWarnings.length > 0
        ? { resolve_warnings: pipelineResult.resolveWarnings }
        : {}),
    }, 200);
  }

  return c.json({ wiki: updated }, 200);
});

wikisRouter.openapi(deleteEntityRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const sql = createSql();

  // Actor context set for ownership checks
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`DELETE FROM entities WHERE id = ${entityId} RETURNING id`,
  ]);

  if ((results[results.length - 1] as Array<{ id: string }>).length === 0) {
    throw new ApiError(404, "not_found", "Entity not found");
  }

  backgroundTask(removeEntity(entityId));

  return new Response(null, { status: 204 });
});

wikisRouter.openapi(bulkDeleteEntitiesRoute, async (c) => {
  const actor = requireActor(c);
  const sql = createSql();

  const userFilter = c.req.query("filter");
  const spaceId = c.req.query("space_id");

  if (!userFilter && !spaceId) {
    throw new ApiError(400, "invalid_query", "At least one of filter or space_id is required");
  }

  // Same implicit filter as GET /wiki — exclude relationships unless explicitly filtered
  const hasKindFilter = userFilter?.split(",").some((expr) => /^kind(!:|!\?|>=|<=|>|<|:|\?)/.test(expr.trim()));
  const implicitFilter = hasKindFilter ? undefined : "kind!:relationship";
  const filter = implicitFilter ? mergeFilters(implicitFilter, userFilter) : userFilter;

  const { whereSql, params } = buildEntityFilterWhere({ filter, spaceId });

  // Guard against unbounded deletes — count first, reject if over limit
  const countResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(`SELECT count(*)::int AS n FROM entities ${whereSql}`, params),
  ]);
  const count = (countResults[countResults.length - 1] as Array<{ n: number }>)[0]?.n ?? 0;
  if (count > BULK_DELETE_LIMIT) {
    throw new ApiError(400, "too_many_entities", `Bulk delete is capped at ${BULK_DELETE_LIMIT} entities, but ${count} matched. Narrow your filter.`);
  }

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(`DELETE FROM entities ${whereSql} RETURNING id`, params),
  ]);

  const deleted = results[results.length - 1] as Array<{ id: string }>;
  const ids = deleted.map((r) => r.id);

  if (ids.length > 0) {
    backgroundTask(removeEntities(ids));
  }

  return c.json({ deleted: ids.length, ids }, 200);
});

wikisRouter.openapi(listVersionsRoute, async (c) => {
  const actor = c.get("actor");
  const entityId = c.req.param("id");
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const cursor = parseCursorParam(c);
  const sql = createSql();

  // Actor context set for entity_versions access
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`
      SELECT ver, properties, edited_by, note, created_at
      FROM entity_versions
      WHERE entity_id = ${entityId}
        AND (${cursor?.i ?? null}::int IS NULL OR ver < ${cursor?.i ?? null}::int)
      ORDER BY ver DESC
      LIMIT ${limit + 1}
    `,
  ]);

  const rows = results[results.length - 1] as VersionRow[];
  const versions = rows.slice(0, limit);
  const next = rows.length > limit ? versions[versions.length - 1] : null;

  return c.json({
    versions,
    cursor: next ? encodeCursor({ t: next.created_at, i: next.ver }) : null,
  }, 200);
});

wikisRouter.openapi(getVersionRoute, async (c) => {
  const actor = c.get("actor");
  const entityId = c.req.param("id");
  const ver = Number.parseInt(c.req.param("ver"), 10);
  if (!Number.isInteger(ver) || ver < 1) {
    throw new ApiError(400, "invalid_path_param", "Invalid version");
  }

  const sql = createSql();
  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`
      SELECT entity_id, ver, properties, edited_by, note, created_at
      FROM entity_versions
      WHERE entity_id = ${entityId} AND ver = ${ver}
      LIMIT 1
    `,
  ]);

  const version = (results[results.length - 1] as VersionRow[])[0];
  if (!version) {
    throw new ApiError(404, "not_found", "Version not found");
  }

  return c.json(version, 200);
});

wikisRouter.openapi(mergeEntityRoute, async (c) => {
  const actor = requireActor(c);
  const targetId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);

  const sourceId = typeof body.source_id === "string" ? body.source_id : null;
  if (!sourceId) {
    throw new ApiError(400, "missing_required_field", "Missing source_id");
  }
  if (sourceId === targetId) {
    throw new ApiError(400, "invalid_body", "Cannot merge an entity into itself");
  }

  const expectedVer = typeof body.ver === "number" ? body.ver : null;
  if (expectedVer === null) {
    throw new ApiError(400, "missing_required_field", "Missing ver");
  }

  const strategy = typeof body.property_strategy === "string"
    ? body.property_strategy
    : "keep_source";
  if (!["keep_target", "keep_source", "shallow_merge", "accumulate"].includes(strategy)) {
    throw new ApiError(400, "invalid_body", "Invalid property_strategy");
  }

  const note = typeof body.note === "string" ? body.note : null;
  const sql = createSql();
  const now = new Date().toISOString();

  // Single atomic transaction for the entire merge
  const results = await sql.transaction([
    ...setActorContext(sql, actor),

    // Fetch both entities
    sql.query(
      `SELECT * FROM entities WHERE id = ANY($1)`,
      [[targetId, sourceId]],
    ),

    // Fetch relationship edges if these are relationships (for endpoint validation)
    sql.query(
      `SELECT id, source_id, target_id FROM relationship_edges WHERE id = ANY($1)`,
      [[targetId, sourceId]],
    ),
  ]);

  const ctxLen = 1; // setActorContext produces 1 query
  const lockedRows = results[ctxLen] as EntityRecord[];
  const target = lockedRows.find((r) => r.id === targetId);
  const source = lockedRows.find((r) => r.id === sourceId);

  if (!target) {
    throw new ApiError(404, "not_found", "Target entity not found");
  }
  if (!source) {
    throw new ApiError(404, "not_found", "Source entity not found");
  }

  // Validate same kind
  if (source.kind !== target.kind) {
    throw new ApiError(400, "invalid_body", "Cannot merge entities of different kinds");
  }

  // If relationships, validate same endpoints
  if (source.kind === "relationship") {
    const edgeRows = results[ctxLen + 1] as Array<{ id: string; source_id: string; target_id: string }>;
    const targetEdge = edgeRows.find((r) => r.id === targetId);
    const sourceEdge = edgeRows.find((r) => r.id === sourceId);

    if (!targetEdge || !sourceEdge) {
      throw new ApiError(400, "invalid_body", "Relationship edge data not found");
    }
    if (targetEdge.source_id !== sourceEdge.source_id || targetEdge.target_id !== sourceEdge.target_id) {
      throw new ApiError(400, "invalid_body", "Cannot merge relationships with different endpoints");
    }
  }

  // Compute merged properties
  let mergedProperties: Record<string, unknown>;
  switch (strategy) {
    case "keep_target":
      mergedProperties = target.properties;
      break;
    case "keep_source":
      mergedProperties = source.properties;
      break;
    case "shallow_merge":
      mergedProperties = { ...target.properties, ...source.properties };
      break;
    case "accumulate":
      mergedProperties = accumulateProperties([target, source] as EntityRecord[]);
      break;
    default:
      mergedProperties = source.properties;
  }

  const newVer = target.ver + 1;
  const mergeDetail = JSON.stringify({
    source_id: sourceId,
    source_type: source.type,
    source_ver: source.ver,
    source_properties: source.properties,
    property_strategy: strategy,
  });

  // Execute the merge via SECURITY DEFINER function (bypasses RLS since
  // app layer already verified admin access on both entities)
  const mergeResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT * FROM perform_entity_merge($1, $2, $3::jsonb, $4, $5, $6, $7, $8::timestamptz, $9::jsonb)`,
      [sourceId, targetId, JSON.stringify(mergedProperties), newVer, expectedVer, actor.id, note, now, mergeDetail],
    ),
  ]);

  const updated = (mergeResults[ctxLen] as EntityRecord[])[0];
  if (!updated) {
    // CAS guard failed — target was modified between validation and merge
    throw new ApiError(409, "cas_conflict", "Target entity was modified during merge, please retry", {
      entity_id: targetId,
      expected_ver: expectedVer,
    });
  }

  // Background tasks: clean up search index
  backgroundTask(removeEntity(sourceId));
  backgroundTask(indexEntity(updated));

  return c.json({ wiki: updated }, 200);
});

// ---------------------------------------------------------------------------
// Batch merge handler
// ---------------------------------------------------------------------------


/**
 * Accumulate properties from multiple entities. Never drops information:
 * - Strings: keep longest
 * - Arrays: union (concat + dedupe by JSON equality)
 * - Objects: recursive deep merge
 * - Other types: keep first non-null
 */
function accumulateProperties(
  entities: EntityRecord[],
): Record<string, unknown> {
  let result: Record<string, unknown> = {};
  for (const entity of entities) {
    if (!entity.properties) continue;
    result = deepMergeObjects(result, entity.properties as Record<string, unknown>);
  }
  return result;
}

wikisRouter.openapi(mergeBatchRoute, async (c) => {
  const actor = requireActor(c);
  const body = await parseJsonBody<{
    groups: Array<{ entity_ids: string[] }>;
    property_strategy?: string;
  }>(c);

  const groups = body.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new ApiError(400, "invalid_body", "groups must be a non-empty array");
  }
  if (groups.length > 100) {
    throw new ApiError(400, "invalid_body", "Maximum 100 groups per request");
  }

  const strategy = body.property_strategy ?? "accumulate";
  if (!["keep_target", "keep_source", "shallow_merge", "accumulate"].includes(strategy)) {
    throw new ApiError(400, "invalid_body", "Invalid property_strategy");
  }

  // Dedupe IDs within each group, then validate no ID across groups
  const deduplicatedGroups: Array<{ entity_ids: string[] }> = [];
  const allIds: string[] = [];
  const globalSeenIds = new Set<string>();
  for (const group of groups) {
    if (!Array.isArray(group.entity_ids) || group.entity_ids.length < 2) {
      throw new ApiError(400, "invalid_body", "Each group must have at least 2 entity_ids");
    }
    if (group.entity_ids.length > 500) {
      throw new ApiError(400, "invalid_body", "Maximum 500 entities per group");
    }
    // Dedupe within group
    const uniqueIds = [...new Set(group.entity_ids)];
    if (uniqueIds.length < 2) {
      throw new ApiError(400, "invalid_body", "Each group must have at least 2 unique entity_ids");
    }
    deduplicatedGroups.push({ entity_ids: uniqueIds });
    for (const id of uniqueIds) {
      if (globalSeenIds.has(id)) {
        throw new ApiError(400, "invalid_body", `Entity ${id} appears in multiple groups`);
      }
      globalSeenIds.add(id);
      allIds.push(id);
    }
  }

  const sql = createSql();

  // Bulk-fetch all entities
  const fetchResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(`SELECT * FROM entities WHERE id = ANY($1::text[])`, [allIds]),
  ]);

  const ctxLen = 1;
  const fetchedRows = fetchResults[ctxLen] as EntityRecord[];
  const entityMap = new Map<string, EntityRecord>();
  for (const row of fetchedRows) {
    entityMap.set(row.id, row);
  }

  // Verify all entities exist
  const missing = allIds.filter((id) => !entityMap.has(id));
  if (missing.length > 0) {
    throw new ApiError(404, "not_found", `Entities not found: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ""}`);
  }

  const now = new Date().toISOString();

  // Process each group
  type GroupResult = {
    target_id: string;
    merged_count: number;
    final_ver: number;
    error: string | null;
    source_ids: string[];
  };

  // If any entities are relationships, fetch edge data for endpoint validation
  const relationshipIds = allIds.filter((id) => entityMap.get(id)!.kind === "relationship");
  const edgeMap = new Map<string, { source_id: string; target_id: string }>();
  if (relationshipIds.length > 0) {
    const edgeResults = await sql.transaction([
      ...setActorContext(sql, actor),
      sql.query(
        `SELECT id, source_id, target_id FROM relationship_edges WHERE id = ANY($1::text[])`,
        [relationshipIds],
      ),
    ]);
    for (const row of edgeResults[ctxLen] as Array<{ id: string; source_id: string; target_id: string }>) {
      edgeMap.set(row.id, { source_id: row.source_id, target_id: row.target_id });
    }
  }

  const processGroup = async (group: { entity_ids: string[] }): Promise<GroupResult> => {
    const entities = group.entity_ids.map((id) => entityMap.get(id)!);

    // Validate same kind within group
    const kinds = new Set(entities.map((e) => e.kind));
    if (kinds.size > 1) {
      return {
        target_id: "",
        merged_count: 0,
        final_ver: 0,
        error: "All entities in group must have the same kind",
        source_ids: [],
      };
    }

    // If relationships, validate all share the same endpoints
    if (entities[0].kind === "relationship") {
      const firstEdge = edgeMap.get(entities[0].id);
      if (!firstEdge) {
        return {
          target_id: "",
          merged_count: 0,
          final_ver: 0,
          error: "Relationship edge data not found",
          source_ids: [],
        };
      }
      for (let i = 1; i < entities.length; i++) {
        const edge = edgeMap.get(entities[i].id);
        if (!edge || edge.source_id !== firstEdge.source_id || edge.target_id !== firstEdge.target_id) {
          return {
            target_id: "",
            merged_count: 0,
            final_ver: 0,
            error: "Cannot merge relationships with different endpoints",
            source_ids: [],
          };
        }
      }
    }

    // Pick target: entity with most property keys, tie-break by oldest (lowest ULID)
    const sorted = [...entities].sort((a, b) => {
      const aKeys = Object.keys(a.properties || {}).length;
      const bKeys = Object.keys(b.properties || {}).length;
      if (aKeys !== bKeys) return bKeys - aKeys; // more keys first
      return a.id < b.id ? -1 : 1; // older first
    });

    const target = sorted[0];
    const sources = sorted.slice(1);
    const sourceIds = sources.map((s) => s.id);

    // Compute merged properties based on strategy
    let mergedProperties: Record<string, unknown>;
    switch (strategy) {
      case "keep_target":
        mergedProperties = target.properties ?? {};
        break;
      case "keep_source":
        mergedProperties = sources[sources.length - 1]?.properties ?? {};
        break;
      case "shallow_merge": {
        mergedProperties = { ...(target.properties ?? {}) };
        for (const source of sources) {
          mergedProperties = { ...mergedProperties, ...(source.properties ?? {}) };
        }
        break;
      }
      case "accumulate":
      default:
        mergedProperties = accumulateProperties([target, ...sources]);
        break;
    }

    // Build merge details array (one per source)
    const mergeDetails = sources.map((source) => ({
      source_id: source.id,
      source_type: source.type,
      source_ver: source.ver,
      source_properties: source.properties,
      property_strategy: strategy,
    }));

    const groupSql = createSql();
    try {
      const mergeResults = await groupSql.transaction([
        ...setActorContext(groupSql, actor),
        groupSql.query(
          `SELECT * FROM perform_group_merge($1, $2::text[], $3::jsonb, $4, $5, $6::timestamptz, $7::jsonb[])`,
          [
            target.id,
            sourceIds,
            JSON.stringify(mergedProperties),
            target.ver,
            actor.id,
            now,
            mergeDetails.map((d) => JSON.stringify(d)),
          ],
        ),
      ]);

      const updated = (mergeResults[ctxLen] as EntityRecord[])[0];
      if (!updated) {
        return {
          target_id: target.id,
          merged_count: 0,
          final_ver: target.ver,
          error: "CAS conflict — target was modified during merge",
          source_ids: sourceIds,
        };
      }

      return {
        target_id: target.id,
        merged_count: sourceIds.length,
        final_ver: updated.ver,
        error: null,
        source_ids: sourceIds,
      };
    } catch (err) {
      return {
        target_id: target.id,
        merged_count: 0,
        final_ver: target.ver,
        error: err instanceof Error ? err.message : "Unknown error",
        source_ids: sourceIds,
      };
    }
  };

  // Execute groups with bounded concurrency (10 at a time)
  const CONCURRENCY = 10;
  const results: GroupResult[] = [];
  for (let i = 0; i < deduplicatedGroups.length; i += CONCURRENCY) {
    const batch = deduplicatedGroups.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(batch.map(processGroup));
    for (const result of batchResults) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        results.push({
          target_id: "",
          merged_count: 0,
          final_ver: 0,
          error: result.reason instanceof Error ? result.reason.message : "Unknown error",
          source_ids: [],
        });
      }
    }
  }

  // Background: clean up search index for all deleted sources, re-index targets
  for (const result of results) {
    if (result.error === null) {
      for (const sourceId of result.source_ids) {
        backgroundTask(removeEntity(sourceId));
      }
      backgroundTask(indexEntityById(result.target_id));
    }
  }

  const merged = results.reduce((sum, r) => sum + r.merged_count, 0);
  const failed = results.filter((r) => r.error !== null).length;

  return c.json({
    merged,
    failed,
    groups: results.map((r) => ({
      target_id: r.target_id,
      merged_count: r.merged_count,
      final_ver: r.final_ver,
      error: r.error,
    })),
  }, 200);
});

wikisRouter.openapi(bulkGetEntitiesRoute, async (c) => {
  const actor = c.get("actor");
  const body = await parseJsonBody<{ ids: string[] }>(c);

  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    throw new ApiError(400, "invalid_body", "ids must be a non-empty array");
  }
  if (body.ids.length > 100) {
    throw new ApiError(400, "invalid_body", "Maximum 100 IDs per request");
  }

  const projection = parseProjection(c.req.query("view"), c.req.query("fields"));
  const sql = createSql();

  const txResults = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `SELECT * FROM entities WHERE id = ANY($1::text[])`,
      [body.ids],
    ),
  ]);

  const rowMap = new Map<string, Record<string, unknown>>();
  for (const row of txResults[txResults.length - 1] as Array<Record<string, unknown>>) {
    rowMap.set(String(row.id), row);
  }

  // Preserve requested order, omit missing/hidden
  const entities = body.ids
    .map((id: string) => rowMap.get(id))
    .filter((row): row is Record<string, unknown> => row !== undefined);

  if (projection.view === "expanded") {
    const relLimit = Math.min(Number(c.req.query("rel_limit")) || 20, 100);
    const visibleIds = entities.map((e) => String(e.id));
    const relMap = await fetchRelationshipContext(sql, actor, visibleIds, relLimit);

    return c.json({
      entities: entities.map((row) => {
        const ctx = relMap.get(String(row.id));
        return {
          ...projectEntity(row, { view: "full", fields: null }),
          _relationships: ctx?.items ?? [],
          _relationships_truncated: ctx?.truncated ?? false,
        };
      }),
    }, 200);
  }

  return c.json({
    entities: entities.map((row) => projectEntity(row, projection)),
  }, 200);
});
