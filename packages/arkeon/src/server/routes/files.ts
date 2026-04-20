// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /files — CRUD for file entities (documents uploaded via `arkeon add`).
 *
 * Files are source material that feeds the extraction pipeline. They skip
 * the wiki link pipeline entirely — content is stored as-is, and new files
 * are automatically enqueued for entity extraction.
 */

import { createRoute, z } from "@hono/zod-openapi";
import postgres from "postgres";

import { requireActor, parseCursorParam, parseJsonBody, parseLimit } from "../lib/http";
import { fetchSpaceForActor, resolveDefaultSpace } from "../lib/spaces";
import { ApiError } from "../lib/errors";
import { generateUlid } from "../lib/ids";
import { createRouter } from "../lib/openapi";
import { createSql, withTransaction } from "../lib/sql";
import { setActorContext, withSystemActorContext } from "../lib/actor-context";
import { indexEntity, removeEntity } from "../lib/meilisearch";
import { backgroundTask } from "../lib/background";
import { encodeCursor } from "../lib/cursor";
import { parseProjection, projectEntity } from "../lib/entity-projection";
import { buildEntityListingQuery, mergeFilters, parseOrder, parseSort } from "../lib/listing";
import type { EntityRecord } from "../lib/entities";
import {
  EntityIdParam,
  EntitySchema,
  ProjectionQuery,
  errorResponses,
  filterQuerySchema,
  jsonContent,
  paginationQuerySchema,
  entityIdParams,
  queryParam,
  cursorResponseSchema,
} from "../lib/schemas";

/** Strip reserved file property keys from caller-supplied properties bag. */
const FILE_RESERVED_KEYS = new Set([
  "label", "subject_type", "content", "status",
  "source_file", "source_hash", "file_type", "folder",
]);

function sanitizeFileProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(properties).filter(([key]) => !FILE_RESERVED_KEYS.has(key)),
  );
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const createFileRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createFile",
  tags: ["Files"],
  summary: "Upload a file to the knowledge graph for entity extraction",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /files", "GET /files/{id}"],
  "x-arke-rules": [
    "Returns 409 if a file with the same label already exists in the space",
    "If space_id is omitted, falls back to the only space the actor can contribute to; 400 if ambiguous or none",
    "Content is stored as-is — no wiki link resolution",
    "Automatically enqueued for entity extraction",
  ],
  request: {
    body: {
      content: jsonContent(
        z.object({
          label: z
            .string()
            .min(1)
            .max(200)
            .describe("Display name for the file (typically the filename or relative path)"),
          content: z
            .string()
            .min(1)
            .describe("Text content of the file. Binary files should describe themselves."),
          source_file: z
            .string()
            .min(1)
            .max(500)
            .optional()
            .describe("Relative filesystem path of the source file (for change detection)"),
          source_hash: z
            .string()
            .optional()
            .describe("SHA256 hash of the source file content (for change detection)"),
          file_type: z
            .string()
            .min(1)
            .max(80)
            .optional()
            .describe("Normalized file extension: markdown, text, latex, pdf, etc."),
          folder: z
            .string()
            .min(1)
            .max(500)
            .optional()
            .describe("Organizational folder path (e.g. 'physics/quantum'). No leading/trailing slashes."),
          properties: z
            .record(z.string(), z.any())
            .optional()
            .describe("Additional JSON properties to store on the file entity"),
          space_id: EntityIdParam
            .optional()
            .describe("Space to create the file in. Optional — defaults to the only space the actor can contribute to."),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "File created and enqueued for extraction",
      content: jsonContent(z.object({ file: EntitySchema })),
    },
    ...errorResponses([400, 401, 403, 409]),
  },
});

const listFilesRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listFiles",
  tags: ["Files"],
  summary: "List file entities with filtering, sorting, and cursor pagination",
  "x-arke-auth": "optional",
  "x-arke-related": ["GET /files/{id}", "GET /wiki"],
  "x-arke-rules": [
    "Only returns entities with type=file — wiki entities are excluded",
    "Relationships (kind=relationship) are always excluded",
  ],
  request: {
    query: filterQuerySchema(["updated_at", "created_at"], "updated_at")
      .merge(ProjectionQuery)
      .merge(paginationQuerySchema(50, 200))
      .merge(z.object({
        space_id: queryParam("space_id", z.string().optional(), "Scope results to a space ULID"),
      })),
  },
  responses: {
    200: {
      description: "Paginated file list",
      content: jsonContent(cursorResponseSchema("files", EntitySchema)),
    },
    ...errorResponses([400, 403]),
  },
});

const getFileRoute = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getFile",
  tags: ["Files"],
  summary: "Fetch a single file entity by ID",
  "x-arke-auth": "optional",
  "x-arke-related": ["PUT /files/{id}", "DELETE /files/{id}"],
  "x-arke-rules": ["Returns 404 if entity does not exist or is not a file"],
  request: {
    params: entityIdParams(),
    query: ProjectionQuery,
  },
  responses: {
    200: {
      description: "File entity",
      content: jsonContent(z.object({ file: EntitySchema })),
    },
    ...errorResponses([404]),
  },
});

const updateFileRoute = createRoute({
  method: "put",
  path: "/{id}",
  operationId: "updateFile",
  tags: ["Files"],
  summary: "Update file properties (content, source_hash, etc.)",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /files/{id}"],
  "x-arke-rules": [
    "Only the owner or an admin may update",
    "Optimistic concurrency: must pass current ver to update",
    "Properties are shallow-merged: only provided keys are updated, omitted keys are preserved",
    "Re-enqueues for extraction if content changes",
  ],
  request: {
    params: entityIdParams(),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          ver: z.number().int().describe("Expected current version (CAS token)"),
          properties: z.record(z.string(), z.any()).optional(),
          remove_properties: z
            .array(z.string())
            .optional()
            .describe("Property keys to delete"),
          note: z.string().optional(),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "File updated",
      content: jsonContent(z.object({ file: EntitySchema })),
    },
    ...errorResponses([400, 401, 403, 404, 409]),
  },
});

const deleteFileRoute = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "deleteFile",
  tags: ["Files"],
  summary: "Delete a file entity",
  "x-arke-auth": "required",
  "x-arke-rules": ["Only the owner or an admin may delete"],
  request: { params: entityIdParams() },
  responses: {
    204: { description: "File deleted" },
    ...errorResponses([401, 403, 404]),
  },
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const filesRouter = createRouter();

filesRouter.openapi(createFileRoute, async (c) => {
  const actor = requireActor(c);
  const body = await parseJsonBody<Record<string, unknown>>(c);

  const label = typeof body.label === "string" ? body.label.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";
  if (!label) throw new ApiError(400, "missing_required_field", "Missing label");
  if (!content) throw new ApiError(400, "missing_required_field", "Missing content");

  const source_file = typeof body.source_file === "string" ? body.source_file : undefined;
  const source_hash = typeof body.source_hash === "string" ? body.source_hash : undefined;
  const file_type = typeof body.file_type === "string" ? body.file_type : undefined;
  const folder = typeof body.folder === "string" && body.folder.trim().length > 0 ? body.folder.trim() : undefined;
  const space_id_input = typeof body.space_id === "string" ? body.space_id : undefined;
  const extraProperties = sanitizeFileProperties(
    typeof body.properties === "object" && body.properties !== null && !Array.isArray(body.properties)
      ? (body.properties as Record<string, unknown>)
      : {},
  );

  const space_id = space_id_input?.trim()
    ? space_id_input
    : await resolveDefaultSpace(actor);

  const targetSpace = await fetchSpaceForActor(actor, space_id);
  if (!targetSpace) {
    throw new ApiError(404, "not_found", "Space not found");
  }

  const fileId = generateUlid();
  const now = new Date().toISOString();

  const fileProperties: Record<string, unknown> = {
    ...extraProperties,
    label,
    subject_type: "document",
    content,
    status: "published",
    ...(source_file ? { source_file } : {}),
    ...(source_hash ? { source_hash } : {}),
    ...(file_type ? { file_type } : {}),
    ...(folder ? { folder } : {}),
  };

  // Check for existing file with same label in space
  const publishedFile = await withTransaction(async (tx) => {
    for (const q of setActorContext(tx, actor)) await q;

    const existing = await tx`
      SELECT e.id FROM entities e
      JOIN space_entities se ON se.entity_id = e.id
      WHERE se.space_id = ${space_id}
        AND e.type = 'file'
        AND e.kind = 'entity'
        AND lower(e.properties->>'label') = lower(${label})
      LIMIT 1
    `;
    if (existing.length > 0) {
      throw new ApiError(409, "file_exists", "A file with this label already exists in the space", {
        existing_file_id: String(existing[0].id),
      });
    }

    await tx`
      INSERT INTO entities (
        id, kind, type, ver, properties, owner_id,
        edited_by, note, created_at, updated_at
      ) VALUES (
        ${fileId}, 'entity', 'file', 1, ${fileProperties}::jsonb, ${actor.id},
        ${actor.id}, NULL, ${now}::timestamptz, ${now}::timestamptz
      )
    `;

    await tx`
      INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
      VALUES (${fileId}, 1, ${fileProperties}::jsonb, ${actor.id}, NULL, ${now}::timestamptz)
    `;

    await tx`
      INSERT INTO space_entities (space_id, entity_id, added_by, added_at)
      VALUES (${space_id}, ${fileId}, ${actor.id}, ${now}::timestamptz)
      ON CONFLICT (space_id, entity_id) DO NOTHING
    `;

    const [row] = await tx`SELECT * FROM entities WHERE id = ${fileId}`;
    return row;
  });

  backgroundTask(indexEntity(publishedFile as Record<string, unknown>));

  // Enqueue for entity extraction
  backgroundTask(
    withSystemActorContext(async (sql) => {
      await sql`
        INSERT INTO source_extract_queue (entity_id, owner_agent, status, created_at)
        VALUES (${fileId}, ${actor.id}, 'pending', NOW())
        ON CONFLICT (entity_id) DO NOTHING
      `;
    }).catch((err) => {
      console.warn(`[files] failed to enqueue ${fileId} for extraction:`, (err as Error).message);
    }),
  );

  return c.json({ file: publishedFile }, 201);
});

filesRouter.openapi(listFilesRoute, async (c) => {
  const sql = createSql();
  const actorCtx = c.get("actor");
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const projection = parseProjection(c.req.query("view"), c.req.query("fields"));
  const cursor = parseCursorParam(c);
  const order = parseOrder(c.req.query("order"));
  const sort = parseSort(c.req.query("sort"), ["updated_at", "created_at"], "updated_at");

  const userFilter = c.req.query("filter");
  const filter = mergeFilters("kind!:relationship,type:file", userFilter);

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
    files: entities.map((row) => projectEntity(row, projection)),
    cursor: next ? encodeCursor({ t: (next[sort] ?? next.updated_at) as string | Date, i: String(next.id) }) : null,
  }, 200);
});

filesRouter.openapi(getFileRoute, async (c) => {
  const actor = c.get("actor");
  const projection = parseProjection(c.req.query("view"), c.req.query("fields"));
  const entityId = c.req.param("id");
  const sql = createSql();

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`SELECT * FROM entities WHERE id = ${entityId} AND type = 'file' LIMIT 1`,
  ]);

  const entity = (results[results.length - 1] as EntityRecord[])[0];
  if (!entity) {
    throw new ApiError(404, "not_found", "File not found");
  }

  return c.json({ file: projectEntity(entity, projection) }, 200);
});

filesRouter.openapi(updateFileRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const expectedVer = typeof body.ver === "number" ? body.ver : null;
  if (expectedVer === null) {
    throw new ApiError(400, "missing_required_field", "Missing ver");
  }

  const properties = body.properties === undefined
    ? undefined
    : (typeof body.properties === "object" && body.properties !== null && !Array.isArray(body.properties)
      ? (body.properties as Record<string, unknown>)
      : (() => { throw new ApiError(400, "invalid_request", "properties must be an object"); })());
  const removeProperties = Array.isArray(body.remove_properties)
    ? (body.remove_properties as string[]).filter((k) => typeof k === "string" && k.length > 0)
    : [];
  const note = body.note === undefined ? null : typeof body.note === "string" ? body.note : null;

  if (!properties && removeProperties.length === 0) {
    throw new ApiError(400, "invalid_body", "No changes requested");
  }

  const sql = createSql();
  const now = new Date().toISOString();

  // Detect if content changed (for re-extraction)
  const hasContentUpdate = typeof properties?.content === "string" && (properties.content as string).length > 0;

  // Build dynamic property expression
  const hasMerge = properties && Object.keys(properties).length > 0;
  const hasRemove = removeProperties.length > 0;
  let propsExpr: string;
  const params: unknown[] = [];
  let paramIdx = 1;

  if (hasMerge && hasRemove) {
    propsExpr = `(properties || $${paramIdx}::jsonb) - $${paramIdx + 1}::text[]`;
    params.push(JSON.stringify(properties), removeProperties);
    paramIdx += 2;
  } else if (hasMerge) {
    propsExpr = `properties || $${paramIdx}::jsonb`;
    params.push(JSON.stringify(properties));
    paramIdx += 1;
  } else {
    propsExpr = `properties - $${paramIdx}::text[]`;
    params.push(removeProperties);
    paramIdx += 1;
  }

  const editedByIdx = paramIdx;
  const noteIdx = paramIdx + 1;
  const nowIdx = paramIdx + 2;
  const idIdx = paramIdx + 3;
  const verIdx = paramIdx + 4;
  params.push(actor.id, note, now, entityId, expectedVer);

  let results;
  try {
    results = await sql.transaction([
      ...setActorContext(sql, actor),
      sql.query(
        `UPDATE entities
         SET properties = ${propsExpr},
             ver = ver + 1,
             edited_by = $${editedByIdx},
             note = $${noteIdx},
             updated_at = $${nowIdx}::timestamptz
         WHERE id = $${idIdx} AND ver = $${verIdx} AND type = 'file'
         RETURNING *`,
        params,
      ),
    ]);
  } catch (err) {
    if (err instanceof postgres.PostgresError && err.code === "42501") {
      // RLS denial may mask CAS conflict — check version
      const check = await sql.transaction([
        ...setActorContext(sql, actor),
        sql`SELECT ver FROM entities WHERE id = ${entityId} AND type = 'file' LIMIT 1`,
      ]);
      const fresh = (check[check.length - 1] as Array<{ ver: number }>)[0];
      if (!fresh) throw new ApiError(404, "not_found", "File not found");
      if (fresh.ver !== expectedVer) {
        throw new ApiError(409, "cas_conflict", "Version mismatch", {
          entity_id: entityId,
          expected_ver: expectedVer,
        });
      }
    }
    throw err;
  }

  const updated = (results[results.length - 1] as EntityRecord[])[0];
  if (!updated) {
    const check = await sql.transaction([
      ...setActorContext(sql, actor),
      sql`SELECT ver FROM entities WHERE id = ${entityId} AND type = 'file' LIMIT 1`,
    ]);
    const fresh = (check[check.length - 1] as Array<{ ver: number }>)[0];
    if (!fresh) throw new ApiError(404, "not_found", "File not found");
    if (fresh.ver !== expectedVer) {
      throw new ApiError(409, "cas_conflict", "Version mismatch", {
        entity_id: entityId,
        expected_ver: expectedVer,
      });
    }
    throw new ApiError(403, "forbidden", "You do not have write access on this file");
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

  // Re-enqueue for extraction if content changed
  if (hasContentUpdate) {
    backgroundTask(
      withSystemActorContext(async (sysSql) => {
        await sysSql`
          INSERT INTO source_extract_queue (entity_id, owner_agent, status, created_at)
          VALUES (${entityId}, ${actor.id}, 'pending', NOW())
          ON CONFLICT (entity_id) DO UPDATE SET status = 'pending', created_at = NOW()
        `;
      }).catch((err) => {
        console.warn(`[files] failed to re-enqueue ${entityId} for extraction:`, (err as Error).message);
      }),
    );
  }

  return c.json({ file: updated }, 200);
});

filesRouter.openapi(deleteFileRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const sql = createSql();

  const results = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`DELETE FROM entities WHERE id = ${entityId} AND type = 'file' RETURNING id`,
  ]);

  if ((results[results.length - 1] as Array<{ id: string }>).length === 0) {
    throw new ApiError(404, "not_found", "File not found");
  }

  backgroundTask(removeEntity(entityId));

  return new Response(null, { status: 204 });
});
