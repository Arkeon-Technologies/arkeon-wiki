// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /ops — compatibility bulk ingestion endpoint.
 *
 * The wiki pipeline is the primary authoring path, but repo ingestion,
 * Genesis seeding, and cross-space connection workflows still need a small
 * batch primitive for structured entity and relationship writes.
 */

import { createRoute, z } from "@hono/zod-openapi";

import { backgroundTask } from "../lib/background";
import { ApiError } from "../lib/errors";
import { requireActor, parseJsonBody } from "../lib/http";
import { generateUlid } from "../lib/ids";
import { indexEntityById } from "../lib/meilisearch";
import { createRouter } from "../lib/openapi";
import { fetchSpaceForActor } from "../lib/spaces";
import { setActorContext } from "../lib/actor-context";
import { createSql, withTransaction, type SqlClient } from "../lib/sql";
import {
  DateTimeSchema,
  EntityIdParam,
  JsonObjectSchema,
  errorResponses,
  jsonContent,
  queryParam,
} from "../lib/schemas";

type EntityOp = Record<string, unknown> & {
  op: "entity";
  ref?: string;
  type?: string;
};

type RelateOp = Record<string, unknown> & {
  op: "relate";
  source?: string;
  target?: string;
  predicate?: string;
};

type OpsEnvelope = {
  format?: string;
  defaults?: {
    space_id?: string;
  };
  source?: {
    entity_id?: string;
  };
  ops?: Array<EntityOp | RelateOp>;
};

type CreatedEntityResult = {
  ref: string | null;
  id: string;
  type: string;
  label: string | null;
  action: "created";
};

type CreatedEdgeResult = {
  ref: string | null;
  id: string;
  source: string;
  predicate: string;
  target: string;
};

const OpsEntityResultSchema = z.object({
  ref: z.string().nullable(),
  id: EntityIdParam,
  type: z.string(),
  label: z.string().nullable(),
  action: z.enum(["created"]),
});

const OpsEdgeResultSchema = z.object({
  ref: z.string().nullable(),
  id: EntityIdParam,
  source: EntityIdParam,
  predicate: z.string(),
  target: EntityIdParam,
});

const postOpsRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "postOps",
  tags: ["Ops"],
  summary: "Bulk ingest entities and relationships",
  description:
    "Compatibility endpoint for structured ingestion. Supports `entity` and `relate` operations, " +
    "`defaults.space_id`, and `source.entity_id` provenance. Wiki authoring remains the preferred path for narrative pages.",
  "x-arke-auth": "required",
  "x-arke-rules": [
    "If defaults.space_id is provided, the space must exist",
    "source.entity_id creates extracted_from relationships from every created entity and relationship to the source entity",
  ],
  request: {
    query: z.object({
      dry_run: queryParam("dry_run", z.coerce.boolean().optional(), "Validate and plan IDs without writing"),
    }),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          format: z.literal("arke.ops/v1"),
          defaults: z.object({
            space_id: EntityIdParam.optional(),
          }).optional(),
          source: z.object({
            entity_id: EntityIdParam.optional(),
          }).optional(),
          ops: z.array(JsonObjectSchema).min(1).max(1000),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Ops committed or dry-run planned",
      content: jsonContent(
        z.object({
          format: z.literal("arke.ops/v1"),
          committed: z.boolean(),
          entities: z.array(OpsEntityResultSchema),
          edges: z.array(OpsEdgeResultSchema),
          stats: z.object({
            entities: z.number().int(),
            edges: z.number().int(),
          }),
          errors: z.array(z.any()).optional(),
        }),
      ),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

export const opsRouter = createRouter();

opsRouter.openapi(postOpsRoute, async (c) => {
  const actor = requireActor(c);
  const body = await parseJsonBody<OpsEnvelope>(c);
  const dryRun = c.req.query("dry_run") === "true";

  if (body.format !== "arke.ops/v1") {
    throw new ApiError(400, "invalid_body", "format must be arke.ops/v1");
  }
  if (!Array.isArray(body.ops) || body.ops.length === 0) {
    throw new ApiError(400, "invalid_body", "ops must be a non-empty array");
  }
  if (body.ops.length > 1000) {
    throw new ApiError(400, "invalid_body", "ops is capped at 1000 operations per request");
  }

  const sql = createSql();
  const spaceId = body.defaults?.space_id;
  if (spaceId) {
    const space = await fetchSpaceForActor(actor, spaceId);
    if (!space) {
      throw new ApiError(404, "not_found", "Space not found");
    }
  }

  const planned = planOps(body);
  if (dryRun) {
    return c.json({
      format: "arke.ops/v1" as const,
      committed: false,
      entities: planned.entities,
      edges: planned.edges,
      stats: { entities: planned.entities.length, edges: planned.edges.length },
      errors: [],
    }, 200);
  }

  const now = new Date().toISOString();
  const createdIds: string[] = [];

  await withTransaction(async (tx) => {
    for (const q of setActorContext(tx, actor)) await q;

    if (body.source?.entity_id) {
      await assertVisibleEntity(tx, body.source.entity_id, "source.entity_id");
    }

    for (const item of planned.entitiesToInsert) {
      await insertEntity(tx, {
        id: item.id,
        kind: "entity",
        type: item.type,
        properties: item.properties,
        ownerId: actor.id,
        now,
      });
      createdIds.push(item.id);

      if (spaceId) {
        await addEntityToSpace(tx, spaceId, item.id, actor.id, now);
      }
    }

    for (const item of planned.edgesToInsert) {
      await insertRelationship(tx, {
        id: item.id,
        sourceId: item.source,
        targetId: item.target,
        predicate: item.predicate,
        properties: item.properties,
        ownerId: actor.id,
        now,
      });
      createdIds.push(item.id);

      if (spaceId) {
        await addEntityToSpace(tx, spaceId, item.id, actor.id, now);
      }
    }

    if (body.source?.entity_id) {
      const sourceEntityId = body.source.entity_id;
      const provenanceSources = [...createdIds];
      for (const id of provenanceSources) {
        const provenanceId = generateUlid();
        await insertRelationship(tx, {
          id: provenanceId,
          sourceId: id,
          targetId: sourceEntityId,
          predicate: "extracted_from",
          properties: {},
          ownerId: actor.id,
          now,
        });
        createdIds.push(provenanceId);

        if (spaceId) {
          await addEntityToSpace(tx, spaceId, provenanceId, actor.id, now);
        }
      }
    }
  });

  for (const id of createdIds) {
    backgroundTask(indexEntityById(id));
  }

  return c.json({
    format: "arke.ops/v1" as const,
    committed: true,
    entities: planned.entities,
    edges: planned.edges,
    stats: { entities: planned.entities.length, edges: planned.edges.length },
    errors: [],
  }, 200);
});

function planOps(body: OpsEnvelope) {
  const refs = new Map<string, string>();
  const entities: CreatedEntityResult[] = [];
  const edges: CreatedEdgeResult[] = [];
  const entitiesToInsert: Array<{
    id: string;
    type: string;
    properties: Record<string, unknown>;
  }> = [];
  const edgesToInsert: Array<{
    id: string;
    source: string;
    target: string;
    predicate: string;
    properties: Record<string, unknown>;
  }> = [];

  for (const [index, op] of body.ops!.entries()) {
    if (!op || typeof op !== "object" || Array.isArray(op)) {
      throw new ApiError(400, "invalid_body", `ops[${index}] must be an object`);
    }

    if (op.op === "entity") {
      const id = generateUlid();
      const ref = typeof op.ref === "string" ? op.ref : null;
      const type = stringField(op.type, `ops[${index}].type`);
      const properties = entityProperties(op);
      if (ref) {
        if (refs.has(ref)) {
          throw new ApiError(400, "invalid_body", `Duplicate op ref ${ref}`);
        }
        refs.set(ref, id);
      }
      entities.push({
        ref,
        id,
        type,
        label: typeof properties.label === "string" ? properties.label : null,
        action: "created",
      });
      entitiesToInsert.push({
        id,
        type,
        properties,
      });
      continue;
    }

    if (op.op === "relate") {
      const id = generateUlid();
      const ref = typeof op.ref === "string" ? op.ref : null;
      const source = resolveEndpoint(op.source, refs, `ops[${index}].source`);
      const target = resolveEndpoint(op.target, refs, `ops[${index}].target`);
      const predicate = stringField(op.predicate, `ops[${index}].predicate`);
      const properties = relationshipProperties(op);
      if (ref) {
        if (refs.has(ref)) {
          throw new ApiError(400, "invalid_body", `Duplicate op ref ${ref}`);
        }
        refs.set(ref, id);
      }
      edges.push({ ref, id, source, predicate, target });
      edgesToInsert.push({
        id,
        source,
        target,
        predicate,
        properties,
      });
      continue;
    }

    throw new ApiError(400, "invalid_body", `Unsupported op at ops[${index}]`);
  }

  return { entities, edges, entitiesToInsert, edgesToInsert };
}

function entityProperties(op: EntityOp): Record<string, unknown> {
  return {
    ...omit(op, ["op", "ref", "type"]),
    subject_type: op.type,
  };
}

function relationshipProperties(op: RelateOp): Record<string, unknown> {
  return omit(op, ["op", "ref", "source", "target", "predicate"]);
}

function omit(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const skip = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !skip.has(key)));
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, "invalid_body", `${field} is required`);
  }
  return value.trim();
}

function resolveEndpoint(value: unknown, refs: Map<string, string>, field: string): string {
  const raw = stringField(value, field);
  return refs.get(raw) ?? raw;
}

async function assertVisibleEntity(tx: SqlClient, id: string, field: string): Promise<void> {
  const rows = await tx`SELECT id FROM entities WHERE id = ${id} LIMIT 1`;
  if (rows.length === 0) {
    throw new ApiError(404, "not_found", `${field} not found or not visible`);
  }
}

async function insertEntity(
  tx: SqlClient,
  options: {
    id: string;
    kind: "entity";
    type: string;
    properties: Record<string, unknown>;
    ownerId: string;
    now: string;
  },
): Promise<void> {
  const [entity] = await tx`
    INSERT INTO entities (
      id, kind, type, ver, properties, owner_id,
      edited_by, note, created_at, updated_at
    ) VALUES (
      ${options.id}, ${options.kind}, ${options.type}, 1, ${options.properties}::jsonb, ${options.ownerId},
      ${options.ownerId}, NULL, ${options.now}::timestamptz, ${options.now}::timestamptz
    )
    RETURNING id
  `;
  if (!entity) {
    throw new ApiError(403, "forbidden", "Unable to create entity");
  }

  await tx`
    INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
    VALUES (${options.id}, 1, ${options.properties}::jsonb, ${options.ownerId}, NULL, ${options.now}::timestamptz)
  `;
}

async function insertRelationship(
  tx: SqlClient,
  options: {
    id: string;
    sourceId: string;
    targetId: string;
    predicate: string;
    properties: Record<string, unknown>;
    ownerId: string;
    now: string;
  },
): Promise<void> {
  // Verify source and target exist
  const sourceRows = await tx`SELECT id FROM entities WHERE id = ${options.sourceId} LIMIT 1`;
  const targetRows = await tx`SELECT id FROM entities WHERE id = ${options.targetId} LIMIT 1`;
  if (sourceRows.length === 0 || targetRows.length === 0) {
    throw new ApiError(404, "not_found", "Relationship source or target not found or not visible");
  }

  await tx`
    INSERT INTO entities (
      id, kind, type, ver, properties, owner_id,
      edited_by, note, created_at, updated_at
    ) VALUES (
      ${options.id}, 'relationship', 'relationship', 1, ${options.properties}::jsonb,
      ${options.ownerId},
      ${options.ownerId}, NULL, ${options.now}::timestamptz, ${options.now}::timestamptz
    )
  `;

  await tx`
    INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
    VALUES (${options.id}, 1, ${options.properties}::jsonb, ${options.ownerId}, NULL, ${options.now}::timestamptz)
  `;

  await tx`
    INSERT INTO relationship_edges (id, source_id, target_id, predicate)
    VALUES (${options.id}, ${options.sourceId}, ${options.targetId}, ${options.predicate})
  `;
}

async function addEntityToSpace(
  tx: SqlClient,
  spaceId: string,
  entityId: string,
  actorId: string,
  now: string,
): Promise<void> {
  await tx`
    INSERT INTO space_entities (space_id, entity_id, added_by, added_at)
    VALUES (${spaceId}, ${entityId}, ${actorId}, ${now}::timestamptz)
    ON CONFLICT (space_id, entity_id) DO NOTHING
  `;
}
