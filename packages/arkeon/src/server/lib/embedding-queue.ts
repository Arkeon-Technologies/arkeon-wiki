// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure SQL helpers for the embedding queue (issue #47).
 *
 * Crash-safe lease-pattern queue, scoped to one concern: "this
 * entity's chunks need re-embedding." The shape is (entity_id) — one
 * row per entity, drained by a single in-process worker.
 *
 *   pending  (started_at IS NULL)
 *     ↓ claim
 *   in_flight (started_at = NOW)
 *     ├─ on success → row DELETEd
 *     └─ on failure → started_at = NULL, last_error set, attempts++
 *
 * Coalescing: rapid edits to the same wiki upsert the row, so 5 saves
 * before the queue drains turns into one embed against the latest
 * chunks. Stale-vs-fresh detection happens inside the worker by
 * comparing entity_chunks.content_hash to entity_embeddings.content_hash
 * — see embedder/worker.ts.
 */

import { createSql } from "./sql.js";

export interface EmbeddingQueueItem {
  id: number;
  entity_id: string;
  enqueued_at: string;
  started_at: string | null;
  attempts: number;
  last_error: string | null;
}

export const ORPHAN_LEASE_MINUTES = 5;
export const MAX_ATTEMPTS = 5;

/**
 * Insert or coalesce a pending row for an entity. Resets started_at
 * and attempts on conflict so a previously-failed entity gets retried
 * the next time it's saved.
 */
export async function enqueueEntity(entityId: string): Promise<number> {
  const sql = createSql();
  const rows = await sql`
    INSERT INTO embedding_queue (entity_id)
    VALUES (${entityId})
    ON CONFLICT(entity_id) DO UPDATE SET
      enqueued_at = datetime('now'),
      started_at = NULL,
      attempts = 0,
      last_error = NULL
    RETURNING id
  `;
  return rows[0].id as number;
}

/**
 * Atomically claim the next pending entity. Returns null if the queue
 * is empty or every pending row has hit MAX_ATTEMPTS.
 */
export async function claimNext(): Promise<EmbeddingQueueItem | null> {
  const sql = createSql();
  const rows = await sql`
    UPDATE embedding_queue
    SET started_at = datetime('now'), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM embedding_queue
      WHERE started_at IS NULL
        AND attempts < ${MAX_ATTEMPTS}
      ORDER BY enqueued_at
      LIMIT 1
    )
    RETURNING *
  `;
  if (rows.length === 0) return null;
  return rowToItem(rows[0]);
}

export async function complete(id: number): Promise<void> {
  const sql = createSql();
  await sql`DELETE FROM embedding_queue WHERE id = ${id}`;
}

export async function fail(id: number, errorMessage: string): Promise<void> {
  const sql = createSql();
  await sql`
    UPDATE embedding_queue
    SET started_at = NULL, last_error = ${errorMessage}
    WHERE id = ${id}
  `;
}

/**
 * Reset rows whose started_at is older than the lease TTL — they
 * belong to a worker that crashed mid-run. Returns the number of
 * rows reclaimed. Run on daemon startup.
 */
export async function reclaimOrphans(
  leaseMinutes: number = ORPHAN_LEASE_MINUTES,
): Promise<number> {
  const sql = createSql();
  const cutoff = `-${leaseMinutes} minutes`;
  const rows = await sql`
    UPDATE embedding_queue
    SET started_at = NULL,
        last_error = 'reclaimed: lease expired (worker crash?)'
    WHERE started_at IS NOT NULL
      AND started_at < datetime('now', ${cutoff})
    RETURNING id
  `;
  return rows.length;
}

/** Diagnostic counts. */
export async function queueStats(): Promise<{ pending: number; in_flight: number }> {
  const sql = createSql();
  const rows = await sql`
    SELECT
      SUM(CASE WHEN started_at IS NULL THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN started_at IS NOT NULL THEN 1 ELSE 0 END) AS in_flight
    FROM embedding_queue
  `;
  return {
    pending: Number(rows[0]?.pending ?? 0),
    in_flight: Number(rows[0]?.in_flight ?? 0),
  };
}

/**
 * Block until the queue is empty (no pending and no in-flight rows).
 * Used by the reindex CLI and tests. Polls every 100ms.
 */
export async function waitForDrain(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stats = await queueStats();
    if (stats.pending === 0 && stats.in_flight === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  const stats = await queueStats();
  throw new Error(
    `embedding queue did not drain within ${timeoutMs}ms ` +
      `(pending=${stats.pending}, in_flight=${stats.in_flight})`,
  );
}

function rowToItem(row: Record<string, unknown>): EmbeddingQueueItem {
  return {
    id: row.id as number,
    entity_id: row.entity_id as string,
    enqueued_at: row.enqueued_at as string,
    started_at: (row.started_at as string | null) ?? null,
    attempts: row.attempts as number,
    last_error: (row.last_error as string | null) ?? null,
  };
}
