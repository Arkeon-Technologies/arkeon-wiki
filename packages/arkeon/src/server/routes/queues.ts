// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createRoute, z } from "@hono/zod-openapi";

import { requireActor } from "../lib/http";
import { createRouter } from "../lib/openapi";
import { errorResponses, jsonContent } from "../lib/schemas";
import { withSystemActorContext } from "../lib/actor-context";

// ---------------------------------------------------------------------------
// Queue definitions — add a row here when a new worker queue is introduced.
// SAFETY: table names are interpolated into SQL strings. Only hardcoded
// values are allowed here — NEVER derive from user input or config.
// ---------------------------------------------------------------------------

interface QueueDef {
  /** Display name returned in the API response */
  name: string;
  /** Postgres table name — must be a valid, hardcoded identifier */
  table: string;
  /** Primary key column name (default: "entity_id") */
  idCol?: string;
  /** Entity column to join for label lookup (default: same as idCol) */
  entityCol?: string;
}

const QUEUE_DEFS: ReadonlyArray<QueueDef> = [
  { name: "extract", table: "source_extract_queue" },
  { name: "draft", table: "wiki_draft_queue" },
  { name: "enrich", table: "wiki_enrich_queue", idCol: "id", entityCol: "target_wiki_id" },
] as const;

/** Allowlist of table names that may appear in queue queries. */
const VALID_QUEUE_TABLES = new Set(QUEUE_DEFS.map((d) => d.table));

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const QueueItemSchema = z.object({
  entity_id: z.string(),
  label: z.string().nullable(),
  status: z.string(),
  error: z.string().nullable(),
  attempts: z.number().int(),
  created_at: z.string(),
  started_at: z.string().nullable(),
});

const QueueStatusSchema = z.object({
  name: z.string(),
  counts: z.record(z.string(), z.number().int()),
  processing: z.array(QueueItemSchema),
  recent_complete: z.array(QueueItemSchema),
  recent_errors: z.array(QueueItemSchema),
});

// ---------------------------------------------------------------------------
// Route definition
// ---------------------------------------------------------------------------

const queuesRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "getQueueStatus",
  tags: ["Queues"],
  summary: "Live status of all background worker queues (extract, draft, enrich)",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /wiki", "POST /wiki"],
  "x-arke-rules": ["Queue status includes entity IDs, labels, and error messages for all actors"],
  request: {
    query: z.object({
      recent: z.coerce
        .number()
        .int()
        .min(0)
        .max(50)
        .default(5)
        .optional()
        .describe("Number of recent completed/failed items to return per queue"),
    }),
  },
  responses: {
    200: {
      description: "Queue status for all background workers",
      content: jsonContent(
        z.object({
          queues: z.array(QueueStatusSchema),
          timestamp: z.string(),
        }),
      ),
    },
    ...errorResponses([401]),
  },
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const queuesRouter = createRouter();

queuesRouter.openapi(queuesRoute, async (c) => {
  requireActor(c);

  const recent = Number(c.req.query("recent"));

  const queues = await withSystemActorContext(async (sql) => {
    const results = [];

    for (const def of QUEUE_DEFS) {
      const t = def.table;
      if (!VALID_QUEUE_TABLES.has(t)) continue;

      // Resolve column names — most queues use entity_id as PK + join col,
      // but the enrich queue uses id as PK and target_wiki_id for label lookup.
      const idCol = def.idCol ?? "entity_id";
      const entityCol = def.entityCol ?? idCol;

      // Single CTE query per queue: counts + processing + recent complete + recent errors
      const rows = await sql.query(
        `WITH
           counts AS (
             SELECT 'count' AS _section, status, count(*)::int AS n,
                    NULL::text AS entity_id, NULL::text AS label,
                    NULL::text AS error, NULL::int AS attempts,
                    NULL::timestamptz AS created_at, NULL::timestamptz AS started_at
             FROM ${t}
             GROUP BY status
           ),
           processing AS (
             SELECT 'processing' AS _section, q.status, NULL::int AS n,
                    q.${idCol} AS entity_id, e.properties->>'label' AS label,
                    q.error, q.attempts, q.created_at, q.started_at
             FROM ${t} q
             LEFT JOIN entities e ON e.id = q.${entityCol}
             WHERE q.status = 'processing'
             ORDER BY q.started_at ASC
           ),
           recent_complete AS (
             SELECT 'recent_complete' AS _section, q.status, NULL::int AS n,
                    q.${idCol} AS entity_id, e.properties->>'label' AS label,
                    q.error, q.attempts, q.created_at, q.started_at
             FROM ${t} q
             LEFT JOIN entities e ON e.id = q.${entityCol}
             WHERE q.status = 'complete'
             ORDER BY q.started_at DESC NULLS LAST
             LIMIT $1
           ),
           recent_errors AS (
             SELECT 'recent_errors' AS _section, q.status, NULL::int AS n,
                    q.${idCol} AS entity_id, e.properties->>'label' AS label,
                    q.error, q.attempts, q.created_at, q.started_at
             FROM ${t} q
             LEFT JOIN entities e ON e.id = q.${entityCol}
             WHERE q.status IN ('failed', 'undraftable')
             ORDER BY q.started_at DESC NULLS LAST
             LIMIT $1
           )
         SELECT * FROM counts
         UNION ALL SELECT * FROM processing
         UNION ALL SELECT * FROM recent_complete
         UNION ALL SELECT * FROM recent_errors`,
        [recent],
      );

      const counts: Record<string, number> = {};
      const processing: unknown[] = [];
      const recentComplete: unknown[] = [];
      const recentErrors: unknown[] = [];

      for (const row of rows as Array<Record<string, unknown>>) {
        const section = row._section as string;
        if (section === "count") {
          counts[row.status as string] = row.n as number;
        } else {
          const item = {
            entity_id: row.entity_id,
            label: row.label,
            status: row.status,
            error: row.error,
            attempts: row.attempts,
            created_at: row.created_at,
            started_at: row.started_at,
          };
          if (section === "processing") processing.push(item);
          else if (section === "recent_complete") recentComplete.push(item);
          else if (section === "recent_errors") recentErrors.push(item);
        }
      }

      results.push({
        name: def.name,
        counts,
        processing,
        recent_complete: recentComplete,
        recent_errors: recentErrors,
      });
    }

    return results;
  });

  return c.json(
    {
      queues,
      timestamp: new Date().toISOString(),
    },
    200,
  );
});
