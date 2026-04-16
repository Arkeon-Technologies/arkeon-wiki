// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createRoute, z } from "@hono/zod-openapi";

import { backgroundTask } from "../lib/background";
import { computeCidFromBytes, isValidCid, MAX_FILE_SIZE } from "../lib/cid";
import type { EntityRecord } from "../lib/entities";
import { ApiError } from "../lib/errors";
import { requireActor, parseJsonBody } from "../lib/http";
import { indexEntity } from "../lib/meilisearch";
import { fanOutNotifications } from "../lib/notifications";
import { createRouter } from "../lib/openapi";
import { setActorContext } from "../lib/actor-context";
import {
  EntityIdParam,
  errorResponses,
  jsonContent,
  pathParam,
  queryParam,
} from "../lib/schemas";
import { createSql } from "../lib/sql";
import { storage } from "../lib/storage";

type ContentEntry = {
  cid: string;
  size: number;
  content_type: string;
  filename?: string;
  uploaded_at: string;
};

function getContentMap(properties: Record<string, unknown>): Record<string, ContentEntry> {
  const content = properties.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return {};
  }
  return content as Record<string, ContentEntry>;
}

function isValidContentKey(key: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(key);
}

async function updateContentMetadata(options: {
  actor: import("../types").Actor;
  entity: EntityRecord;
  expectedVer: number;
  properties: Record<string, unknown>;
  action: string;
  detail: Record<string, unknown>;
  note?: string | null;
}) {
  const sql = createSql();
  const now = new Date().toISOString();
  const txResults = await sql.transaction([
    ...setActorContext(sql, options.actor),
    sql.query(
      `
        UPDATE entities
        SET properties = properties || $1::jsonb,
            ver = ver + 1,
            edited_by = $2,
            note = $3,
            updated_at = $4::timestamptz
        WHERE id = $5
          AND ver = $6
        RETURNING *
      `,
      [
        JSON.stringify(options.properties),
        options.actor.id,
        options.note ?? null,
        now,
        options.entity.id,
        options.expectedVer,
      ],
    ),
  ]);

  const updated = (txResults[txResults.length - 1] as EntityRecord[])[0];
  if (!updated) {
    throw new ApiError(409, "cas_conflict", "Version mismatch", {
      entity_id: options.entity.id,
      expected_ver: options.expectedVer,
    });
  }
  const nextVer = updated.ver;

  await sql.transaction([
    ...setActorContext(sql, options.actor),
    sql.query(
      `
        INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
        SELECT id, ver, properties, edited_by, note, $2::timestamptz
        FROM entities
        WHERE id = $1
      `,
      [options.entity.id, now],
    ),
    sql.query(
      `
        INSERT INTO entity_activity (entity_id, actor_id, action, detail, ts)
        VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)
      `,
      [
        options.entity.id,
        options.actor.id,
        options.action,
        JSON.stringify({ ...options.detail, ver: nextVer }),
        now,
      ],
    ),
  ]);

  backgroundTask(indexEntity(updated));

  return { updated, nextVer, ts: now };
}

const uploadContentRoute = createRoute({
  method: "post",
  path: "/{id}/content",
  operationId: "uploadEntityContent",
  tags: ["Content"],
  summary: "Upload a file directly to an entity.",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /entities/{id}/content", "DELETE /entities/{id}/content"],
  "x-arke-rules": ["Requires write access to the entity (owner, editor, or admin role)", "Optimistic concurrency: must pass current ver to upload"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Entity ULID"),
    }),
    query: z.object({
      key: queryParam(
        "key",
        z.string().min(1).max(128),
        "Content key (alphanumeric, max 128 chars)",
      ),
      ver: queryParam("ver", z.coerce.number().int(), "Expected current version (CAS token). Server increments ver on success."),
      filename: queryParam("filename", z.string().min(1).max(255).optional(), "Optional display filename"),
    }),
  },
  responses: {
    200: {
      description: "Content uploaded",
      content: jsonContent(
        z.object({
          cid: z.string(),
          size: z.number().int(),
          key: z.string(),
          ver: z.number().int(),
        }),
      ),
    },
    ...errorResponses([400, 401, 403, 404, 409, 413]),
  },
});

const getContentRoute = createRoute({
  method: "get",
  path: "/{id}/content",
  operationId: "getEntityContent",
  tags: ["Content"],
  summary: "Download a file from an entity",
  "x-arke-auth": "optional",
  "x-arke-related": ["POST /entities/{id}/content", "DELETE /entities/{id}/content"],
  "x-arke-rules": ["Requires read_level clearance >= entity's read_level"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Entity ULID"),
    }),
    query: z.object({
      key: queryParam("key", z.string().optional(), "Content key (returns first key if omitted)"),
      cid: queryParam("cid", z.string().optional(), "Lookup by CID instead of key"),
    }),
  },
  responses: {
    200: {
      description: "Raw file bytes",
      content: {
        "application/octet-stream": {
          schema: z.string().openapi({ type: "string", format: "binary" }),
        },
      },
    },
    ...errorResponses([400, 403, 404]),
  },
});

const deleteContentRoute = createRoute({
  method: "delete",
  path: "/{id}/content",
  operationId: "deleteEntityContent",
  tags: ["Content"],
  summary: "Delete a file from an entity",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /entities/{id}/content"],
  "x-arke-rules": ["Requires write access to the entity (owner, editor, or admin role)"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Entity ULID"),
    }),
    query: z.object({
      key: queryParam("key", z.string().optional(), "Content key to delete"),
      cid: queryParam("cid", z.string().optional(), "CID to delete"),
      ver: queryParam("ver", z.coerce.number().int(), "Expected current version (CAS token). Server increments ver on success."),
    }),
  },
  responses: {
    204: {
      description: "Content deleted",
    },
    ...errorResponses([400, 401, 403, 404, 409]),
  },
});

const renameContentRoute = createRoute({
  method: "patch",
  path: "/{id}/content",
  operationId: "renameEntityContent",
  tags: ["Content"],
  summary: "Rename a content key",
  "x-arke-auth": "required",
  "x-arke-rules": ["Requires write access to the entity (owner, editor, or admin role)"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Entity ULID"),
    }),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          from: z.string().min(1).max(128).describe("Current content key"),
          to: z.string().min(1).max(128).describe("New content key"),
          ver: z.number().int().describe("Expected current version (CAS token). Server increments ver on success."),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Content key renamed",
      content: jsonContent(z.object({ ok: z.boolean(), ver: z.number().int() })),
    },
    ...errorResponses([400, 401, 403, 404, 409]),
  },
});

export const contentRouter = createRouter();

contentRouter.openapi(uploadContentRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const key = c.req.query("key");
  const filename = c.req.query("filename");
  const verRaw = c.req.query("ver");
  const expectedVer = verRaw ? Number.parseInt(verRaw, 10) : NaN;
  const contentType = c.req.header("content-type");
  const lengthHeader = c.req.header("content-length");
  const declaredLength = lengthHeader ? Number.parseInt(lengthHeader, 10) : null;

  if (!key || !isValidContentKey(key)) {
    throw new ApiError(400, "invalid_query", "Invalid content key");
  }
  if (filename !== undefined && (filename.length < 1 || filename.length > 255)) {
    throw new ApiError(400, "invalid_query", "Invalid filename");
  }
  if (!Number.isInteger(expectedVer)) {
    throw new ApiError(400, "missing_required_field", "Missing ver");
  }
  if (!contentType) {
    throw new ApiError(400, "missing_required_header", "Missing Content-Type");
  }
  if (declaredLength !== null && (!Number.isInteger(declaredLength) || declaredLength < 0)) {
    throw new ApiError(400, "invalid_header", "Invalid Content-Length");
  }
  if (declaredLength !== null && declaredLength > MAX_FILE_SIZE) {
    throw new ApiError(413, "file_too_large", "File exceeds 500 MB limit");
  }

  const sql2 = createSql();
  const entityResults = await sql2.transaction([
    ...setActorContext(sql2, actor),
    sql2`SELECT * FROM entities WHERE id = ${entityId} LIMIT 1`,
  ]);
  const entity = (entityResults[entityResults.length - 1] as EntityRecord[])[0];
  if (!entity) {
    throw new ApiError(404, "not_found", "Entity not found");
  }

  if (entity.ver !== expectedVer) {
    throw new ApiError(409, "cas_conflict", "Version mismatch", {
      entity_id: entityId,
      expected_ver: expectedVer,
      actual_ver: entity.ver,
    });
  }

  const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_SIZE) {
    throw new ApiError(413, "file_too_large", "File exceeds 500 MB limit");
  }

  const cid = await computeCidFromBytes(bytes);
  await storage.put(`${entityId}/${cid}`, bytes, {
    contentType,
    metadata: { cid, entity_id: entityId, key },
  });

  const properties = { ...(entity.properties ?? {}) } as Record<string, unknown>;
  const contentMap = { ...getContentMap(properties) };
  contentMap[key] = {
    cid,
    size: bytes.byteLength,
    content_type: contentType,
    ...(filename ? { filename } : {}),
    uploaded_at: new Date().toISOString(),
  };
  properties.content = contentMap;

  const { nextVer, ts } = await updateContentMetadata({
    actor,
    entity,
    expectedVer,
    properties,
    action: "content_uploaded",
    detail: {
      key,
      cid,
      size: bytes.byteLength,
      content_type: contentType,
      ...(filename ? { filename } : {}),
    },
  });

  backgroundTask(
    fanOutNotifications({
      entity_id: entityId,
      space_id: null,
      actor_id: actor.id,
      action: "content_uploaded",
      detail: { key, cid, size: bytes.byteLength, content_type: contentType, ...(filename ? { filename } : {}) },
      ts,
    }),
  );

  return c.json({
    cid,
    size: bytes.byteLength,
    key,
    ver: nextVer,
  }, 200);
});

contentRouter.openapi(getContentRoute, async (c) => {
  const actorId = c.get("actor")?.id ?? "";
  const entityId = c.req.param("id");
  const key = c.req.query("key");
  const cid = c.req.query("cid");

  if (cid && !isValidCid(cid)) {
    throw new ApiError(400, "invalid_query", "Invalid CID");
  }

  const sql2 = createSql();
  const actor = c.get("actor");
  const entityResults = await sql2.transaction([
    ...setActorContext(sql2, actor),
    sql2`SELECT * FROM entities WHERE id = ${entityId} LIMIT 1`,
  ]);
  const entity = (entityResults[entityResults.length - 1] as EntityRecord[])[0];
  if (!entity) {
    throw new ApiError(404, "not_found", "Entity not found");
  }
  const contentMap = getContentMap(entity.properties ?? {});

  const entry = cid
    ? Object.values(contentMap).find((value) => value.cid === cid)
    : key
      ? contentMap[key]
      : contentMap[Object.keys(contentMap).sort()[0] ?? ""];

  if (!entry || typeof entry.cid !== "string") {
    throw new ApiError(404, "file_not_found", "Content not found");
  }

  const object = await storage.get(`${entityId}/${entry.cid}`);
  if (!object?.body) {
    throw new ApiError(404, "file_not_found", "Content not found");
  }

  const headers = new Headers();
  headers.set("content-type", typeof entry.content_type === "string" ? entry.content_type : "application/octet-stream");
  headers.set("cache-control", "private, max-age=3600");
  if (typeof entry.size === "number") {
    headers.set("content-length", String(entry.size));
  }
  if (typeof entry.filename === "string") {
    headers.set("content-disposition", `attachment; filename="${entry.filename}"`);
  }

  return new Response(object.body, { status: 200, headers });
});

contentRouter.openapi(deleteContentRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const key = c.req.query("key");
  const cid = c.req.query("cid");
  const verRaw = c.req.query("ver");
  const expectedVer = verRaw ? Number.parseInt(verRaw, 10) : NaN;
  if (!Number.isInteger(expectedVer)) {
    throw new ApiError(400, "missing_required_field", "Missing ver");
  }
  if (!key && !cid) {
    throw new ApiError(400, "invalid_query", "Specify key or cid");
  }
  if (cid && !isValidCid(cid)) {
    throw new ApiError(400, "invalid_query", "Invalid CID");
  }

  const sql2 = createSql();
  const entityResults = await sql2.transaction([
    ...setActorContext(sql2, actor),
    sql2`SELECT * FROM entities WHERE id = ${entityId} LIMIT 1`,
  ]);
  const entity = (entityResults[entityResults.length - 1] as EntityRecord[])[0];
  if (!entity) {
    throw new ApiError(404, "not_found", "Entity not found");
  }
  if (entity.ver !== expectedVer) {
    throw new ApiError(409, "cas_conflict", "Version mismatch", {
      entity_id: entityId,
      expected_ver: expectedVer,
      actual_ver: entity.ver,
    });
  }

  const properties = { ...(entity.properties ?? {}) } as Record<string, unknown>;
  const contentMap = { ...getContentMap(properties) };
  let removedKey: string | null = null;
  let removedCid: string | null = null;

  if (key && contentMap[key]) {
    removedKey = key;
    removedCid = contentMap[key]?.cid ?? null;
    delete contentMap[key];
  } else if (cid) {
    for (const [entryKey, entry] of Object.entries(contentMap)) {
      if (entry.cid === cid) {
        removedKey = entryKey;
        removedCid = entry.cid;
        delete contentMap[entryKey];
        break;
      }
    }
  }

  if (!removedKey) {
    throw new ApiError(404, "file_not_found", "Content not found");
  }

  properties.content = contentMap;
  const { nextVer, ts } = await updateContentMetadata({
    actor,
    entity,
    expectedVer,
    properties,
    action: "content_deleted",
    detail: { key: removedKey, cid: removedCid },
  });

  backgroundTask(
    fanOutNotifications({
      entity_id: entityId,
      space_id: null,
      actor_id: actor.id,
      action: "content_deleted",
      detail: { key: removedKey, cid: removedCid, ver: nextVer },
      ts,
    }),
  );

  return new Response(null, { status: 204 });
});

contentRouter.openapi(renameContentRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (typeof body.from !== "string" || typeof body.to !== "string" || typeof body.ver !== "number") {
    throw new ApiError(400, "invalid_body", "Invalid content rename body");
  }
  if (!isValidContentKey(body.from) || !isValidContentKey(body.to)) {
    throw new ApiError(400, "invalid_body", "Invalid content key");
  }

  const sql2 = createSql();
  const entityResults = await sql2.transaction([
    ...setActorContext(sql2, actor),
    sql2`SELECT * FROM entities WHERE id = ${entityId} LIMIT 1`,
  ]);
  const entity = (entityResults[entityResults.length - 1] as EntityRecord[])[0];
  if (!entity) {
    throw new ApiError(404, "not_found", "Entity not found");
  }
  if (entity.ver !== body.ver) {
    throw new ApiError(409, "cas_conflict", "Version mismatch", {
      entity_id: entityId,
      expected_ver: body.ver,
      actual_ver: entity.ver,
    });
  }

  const properties = { ...(entity.properties ?? {}) } as Record<string, unknown>;
  const contentMap = { ...getContentMap(properties) };
  if (!contentMap[body.from]) {
    throw new ApiError(404, "file_not_found", "Content key not found");
  }
  if (body.from !== body.to && contentMap[body.to]) {
    throw new ApiError(409, "already_exists", "Target content key already exists");
  }

  contentMap[body.to] = contentMap[body.from];
  delete contentMap[body.from];
  properties.content = contentMap;

  const { updated, ts } = await updateContentMetadata({
    actor,
    entity,
    expectedVer: body.ver,
    properties,
    action: "content_renamed",
    detail: { from: body.from, to: body.to, cid: contentMap[body.to]?.cid },
  });

  backgroundTask(
    fanOutNotifications({
      entity_id: entityId,
      space_id: null,
      actor_id: actor.id,
      action: "content_renamed",
      detail: { from: body.from, to: body.to, cid: contentMap[body.to]?.cid, ver: updated.ver },
      ts,
    }),
  );

  return c.json({ ok: true, ver: updated.ver }, 200);
});
