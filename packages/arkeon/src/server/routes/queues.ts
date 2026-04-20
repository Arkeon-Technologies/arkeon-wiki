// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createRoute, z } from "@hono/zod-openapi";

import { requireActor } from "../lib/http";
import { createRouter } from "../lib/openapi";
import { errorResponses, jsonContent } from "../lib/schemas";
import { withSystemActorContext } from "../lib/actor-context";

// ---------------------------------------------------------------------------
// Queue definitions — add a row here when a new worker queue is introduced
// ---------------------------------------------------------------------------

interface QueueDef {
  /** Display name returned in the API response */
  name: string;
  /** Postgres table name */
  table: string;
}

const QUEUE_DEFS: QueueDef[] = [
  { name: "extract", table: "source_extract_queue" },
  { name: "draft", table: "wiki_draft_queue" },
];

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
  summary: "Live status of all background worker queues (extract, draft)",
  "x-arke-auth": "required",
  "x-arke-rules": [],
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

  const recent = Number(c.req.query("recent") ?? 5);

  const queues = await withSystemActorContext(async (sql) => {
    const results = [];

    for (const def of QUEUE_DEFS) {
      const t = def.table;

      // Counts by status
      const countRows = await sql.query(
        `SELECT status, count(*)::int AS n FROM ${t} GROUP BY status`,
      );
      const counts: Record<string, number> = {};
      for (const row of countRows as Array<{ status: string; n: number }>) {
        counts[row.status] = row.n;
      }

      // Currently processing items (with labels)
      const processing = await sql.query(
        `SELECT q.entity_id, e.properties->>'label' AS label,
                q.status, q.error, q.attempts, q.created_at, q.started_at
         FROM ${t} q
         LEFT JOIN entities e ON e.id = q.entity_id
         WHERE q.status = 'processing'
         ORDER BY q.started_at ASC`,
      );

      // Recent completions
      const recentComplete = await sql.query(
        `SELECT q.entity_id, e.properties->>'label' AS label,
                q.status, q.error, q.attempts, q.created_at, q.started_at
         FROM ${t} q
         LEFT JOIN entities e ON e.id = q.entity_id
         WHERE q.status = 'complete'
         ORDER BY q.started_at DESC NULLS LAST
         LIMIT $1`,
        [recent],
      );

      // Recent errors (failed + undraftable)
      const recentErrors = await sql.query(
        `SELECT q.entity_id, e.properties->>'label' AS label,
                q.status, q.error, q.attempts, q.created_at, q.started_at
         FROM ${t} q
         LEFT JOIN entities e ON e.id = q.entity_id
         WHERE q.status IN ('failed', 'undraftable')
         ORDER BY q.started_at DESC NULLS LAST
         LIMIT $1`,
        [recent],
      );

      results.push({
        name: def.name,
        counts,
        processing: processing as unknown[],
        recent_complete: recentComplete as unknown[],
        recent_errors: recentErrors as unknown[],
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
