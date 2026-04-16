// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { z } from "@hono/zod-openapi";
import type { ZodTypeAny } from "zod";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const ISO_DATE_TIME_EXAMPLE = "2026-01-01T00:00:00.000Z";

export const UlidSchema = z
  .string()
  .regex(ULID_PATTERN, "Expected a ULID")
  .openapi({ example: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });

export const EntityIdParam = UlidSchema.describe("ULID string");

export const ClassificationLevel = z
  .number()
  .int()
  .min(0)
  .max(4)
  .openapi({ description: "0=PUBLIC, 1=INTERNAL, 2=TEAM, 3=CONFIDENTIAL, 4=RESTRICTED" });

export const DateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .openapi({ example: ISO_DATE_TIME_EXAMPLE });

export const JsonObjectSchema = z.record(z.string(), z.any()).openapi("JsonObject");

export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: "invalid_body" }),
      message: z.string().openapi({ example: "Invalid request" }),
      details: JsonObjectSchema.optional(),
      request_id: z.string().optional().openapi({ example: "req_123" }),
    }),
  })
  .openapi("ErrorResponse");

// --- Entity ---

export const EntitySchema = z
  .object({
    id: UlidSchema,
    kind: z.enum(["entity", "relationship"]),
    type: z.string(),
    ver: z.number().int(),
    properties: JsonObjectSchema,
    owner_id: UlidSchema,
    read_level: ClassificationLevel,
    write_level: ClassificationLevel,
    edited_by: UlidSchema,
    note: z.string().nullable(),
    created_at: DateTimeSchema,
    updated_at: DateTimeSchema,
  })
  .openapi("Entity");

export const EntityResponse = z
  .object({
    entity: EntitySchema,
  })
  .openapi("EntityResponse");

// --- Actor ---

export const ActorSchema = z
  .object({
    id: UlidSchema,
    kind: z.enum(["agent"]),
    max_read_level: ClassificationLevel,
    max_write_level: ClassificationLevel,
    is_admin: z.boolean(),
    can_publish_public: z.boolean(),
    owner_id: UlidSchema.nullable(),
    properties: JsonObjectSchema,
    status: z.enum(["active", "suspended", "deactivated"]),
    created_at: DateTimeSchema,
    updated_at: DateTimeSchema,
  })
  .openapi("Actor");

export const ActorResponse = z
  .object({
    actor: ActorSchema,
  })
  .openapi("ActorResponse");

// --- Space ---

export const SpaceSchema = z
  .object({
    id: UlidSchema,
    name: z.string(),
    description: z.string().nullable(),
    owner_id: UlidSchema,
    read_level: ClassificationLevel,
    write_level: ClassificationLevel,
    status: z.enum(["active", "archived", "deleted"]),
    entity_count: z.number().int(),
    last_activity_at: DateTimeSchema.nullable(),
    properties: JsonObjectSchema,
    created_at: DateTimeSchema,
    updated_at: DateTimeSchema,
  })
  .openapi("Space");

// --- Group ---

export const GroupSchema = z
  .object({
    id: UlidSchema,
    name: z.string(),
    type: z.enum(["org", "project", "editorial", "admin"]),
    read_level: ClassificationLevel,
    created_by: UlidSchema,
    created_at: DateTimeSchema,
  })
  .openapi("Group");

// --- Pagination ---

export const CursorSchema = z
  .string()
  .nullable()
  .openapi({ description: "Opaque pagination cursor", example: "eyJ0Ijoi..." });

export function cursorResponseSchema(key: string, itemSchema: ZodTypeAny) {
  return z.object({
    [key]: z.array(itemSchema),
    cursor: CursorSchema,
  });
}

// --- Query helpers ---

export function pathParam(name: string, schema: ZodTypeAny, description: string) {
  return schema.openapi({
    param: { name, in: "path" },
    description,
  });
}

export function queryParam(name: string, schema: ZodTypeAny, description: string) {
  return schema.openapi({
    param: { name, in: "query" },
    description,
  });
}

export function limitQuerySchema(defaultValue: number, maxValue: number) {
  return queryParam(
    "limit",
    z.coerce.number().int().min(1).max(maxValue).optional(),
    `Max results (default ${defaultValue}, max ${maxValue})`,
  );
}

export function paginationQuerySchema(defaultValue: number, maxValue = 200) {
  return PaginationQuery.extend({
    limit: limitQuerySchema(defaultValue, maxValue),
  });
}

export const PaginationQuery = z.object({
  limit: queryParam(
    "limit",
    z.coerce.number().int().min(1).max(200).optional(),
    "Max results",
  ),
  cursor: queryParam("cursor", z.string().optional(), "Pagination cursor"),
});

export const ProjectionQuery = z.object({
  view: queryParam(
    "view",
    z.enum(["summary", "expanded"]).optional(),
    "Projection: summary | expanded. Default returns all fields. expanded adds _relationships.",
  ),
  fields: queryParam(
    "fields",
    z.string().min(1).optional(),
    "Comma-separated field list",
  ),
});

// --- Relationship expansion (used by view=expanded) ---

export const RelationshipSummarySchema = z
  .object({
    id: UlidSchema,
    predicate: z.string(),
    source_id: UlidSchema,
    target_id: UlidSchema,
    direction: z.enum(["in", "out"]),
    properties: JsonObjectSchema,
    read_level: ClassificationLevel,
    write_level: ClassificationLevel,
    counterpart: z.object({
      id: UlidSchema,
      kind: z.enum(["entity", "relationship"]),
      type: z.string(),
      properties: z.object({ label: z.string().nullable(), description: z.string().nullable() }),
    }),
  })
  .openapi("RelationshipSummary");

// --- Graph Traverse ---

export const TraverseNodeSchema = z
  .object({
    id: UlidSchema,
    kind: z.enum(["entity", "relationship"]),
    type: z.string(),
    properties: z.object({ label: z.string().nullable(), description: z.string().nullable() }),
    read_level: ClassificationLevel,
    created_at: DateTimeSchema,
    updated_at: DateTimeSchema,
    source_depth: z.number().int().describe("Hops from the nearest source entity"),
    target_depth: z.number().int().nullable().describe("Hops from the nearest target entity (null in neighborhood mode)"),
    score: z.number().describe("Ranking score (connectivity + recency + proximity + query relevance)"),
  })
  .openapi("TraverseNode");

export const TraverseEdgeSchema = z
  .object({
    id: UlidSchema,
    source_id: UlidSchema,
    target_id: UlidSchema,
    predicate: z.string(),
    properties: JsonObjectSchema,
  })
  .openapi("TraverseEdge");

export const TraverseResponseSchema = z
  .object({
    source_ids: z.array(UlidSchema).describe("Resolved source entity IDs"),
    target_ids: z.array(UlidSchema).nullable().describe("Resolved target entity IDs (null in neighborhood mode)"),
    nodes: z.array(TraverseNodeSchema).describe("Ranked nodes discovered by traversal"),
    edges: z.array(TraverseEdgeSchema).describe("Edges connecting source, target, and discovered nodes"),
    truncated: z.boolean().describe("True if more results exist beyond the limit"),
  })
  .openapi("TraverseResponse");

// --- Graph data (lightweight visualization) ---

export const GraphNodeSchema = z
  .object({
    id: UlidSchema,
    label: z.string().describe("Display label (from properties.label/title/name or entity type)"),
    type: z.string().describe("Entity type (e.g. person, document, event)"),
    space_ids: z.array(z.string()).describe("Space memberships"),
  })
  .openapi("GraphNode");

export const GraphEdgeSchema = z
  .object({
    id: UlidSchema,
    source_id: UlidSchema,
    target_id: UlidSchema,
    predicate: z.string(),
  })
  .openapi("GraphEdge");

export const GraphDataResponseSchema = z
  .object({
    nodes: z.array(GraphNodeSchema).describe("Lightweight node data for graph rendering"),
    edges: z.array(GraphEdgeSchema).describe("Edges connecting nodes in the result set"),
    cursor: z.string().nullable().describe("Pagination cursor for next page, null if no more results"),
  })
  .openapi("GraphDataResponse");

// --- Expanded entity (view=expanded) ---

export const ExpandedEntitySchema = EntitySchema.extend({
  _relationships: z.array(RelationshipSummarySchema)
    .describe("Relationship summaries with counterpart labels. Capped by rel_limit — use GET /entities/{id}/relationships for the full set."),
  _relationships_truncated: z.boolean()
    .describe("True if more relationships exist than were returned. Use GET /entities/{id}/relationships to paginate through all."),
}).openapi("ExpandedEntity");

export const FilterQuery = z.object({
  filter: queryParam(
    "filter",
    z.string().optional(),
    "Column/property filters. See GET /help for filter syntax.",
  ),
  sort: queryParam("sort", z.string().optional(), "Sort field"),
  order: queryParam("order", z.enum(["asc", "desc"]).optional(), "asc | desc"),
});

export function filterQuerySchema(sortValues: [string, ...string[]], defaultSort: string) {
  return FilterQuery.extend({
    sort: queryParam(
      "sort",
      z.enum(sortValues).optional(),
      `${sortValues.join(" | ")} (default: ${defaultSort})`,
    ),
    order: queryParam(
      "order",
      z.enum(["asc", "desc"]).optional(),
      "asc | desc (default: desc)",
    ),
  });
}

export function entityIdParams(description = "Entity ULID") {
  return z.object({
    id: pathParam("id", EntityIdParam, description),
  });
}

export function jsonContent(schema: ZodTypeAny) {
  return {
    "application/json": {
      schema,
    },
  };
}

const ERROR_STATUS_DESCRIPTIONS: Record<number, string> = {
  400: "Bad request",
  401: "Authentication required",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
  410: "Gone",
  413: "Payload too large",
  422: "Validation error",
  500: "Internal server error",
  501: "Not implemented",
  503: "Service unavailable",
};

export function errorResponses(statuses: number[]) {
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      {
        description: ERROR_STATUS_DESCRIPTIONS[status] ?? `Error ${status}`,
        content: jsonContent(ErrorResponse),
      },
    ]),
  );
}
