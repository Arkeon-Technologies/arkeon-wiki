// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure SQL helpers for the agent queue.
 *
 * The queue is a persistent FIFO of (space, role, source) work items
 * the watcher creates and the scheduler drains. State machine per row:
 *
 *   pending  (started_at IS NULL)
 *     ↓ claim
 *   in_flight (started_at = NOW)
 *     ├─ on success → row DELETEd
 *     └─ on failure → started_at = NULL, last_error set, attempts++
 *
 * Crash recovery: the daemon's startup hook calls reclaimOrphans()
 * which resets started_at on rows with a stale lease (older than the
 * configured TTL). The next claim picks them up.
 *
 * Re-runs of the same (space, role, source) are deduplicated by the
 * UNIQUE constraint — rapid saves coalesce into a single run that
 * uses the latest entity_id.
 */

import { createSql } from "./sql.js";

export interface QueuedItem {
  id: number;
  space_id: string;
  role: string;
  trigger_path: string;
  trigger_entity_id: string | null;
  enqueued_at: string;
  started_at: string | null;
  attempts: number;
  last_error: string | null;
}

/** Default lease TTL: a queued item with started_at older than this is
 *  considered orphaned (left over from a crashed daemon) and reclaimed. */
export const ORPHAN_LEASE_MINUTES = 5;

/** Cap on retry attempts for a single queue row. Once reached, the row
 *  stays in the queue (visible to queueStats / diagnostics) but won't
 *  be claimed again. Prevents runaway tight-loop retries when the
 *  failure is non-transient (bad config, missing key, etc.). */
export const MAX_QUEUE_ATTEMPTS = 5;

export interface EnqueueInput {
  space_id: string;
  role: string;
  trigger_path: string;
  trigger_entity_id?: string | null;
}

/**
 * Insert a new pending row, or coalesce with an existing pending row
 * for the same (space, role, path). Returns the row id.
 *
 * If a row exists and was already claimed (started_at IS NOT NULL),
 * we still upsert: the new save invalidates the in-flight run's
 * input. The runner should detect this on completion and not delete
 * the row — but for simplicity v1 lets the in-flight run finish and
 * deletes; the next save (after this one) re-queues. Acceptable race.
 */
export async function enqueue(input: EnqueueInput): Promise<number> {
  const sql = createSql();
  const rows = await sql`
    INSERT INTO agent_queue (space_id, role, trigger_path, trigger_entity_id)
    VALUES (${input.space_id}, ${input.role}, ${input.trigger_path}, ${input.trigger_entity_id ?? null})
    ON CONFLICT(space_id, role, trigger_path) DO UPDATE SET
      trigger_entity_id = excluded.trigger_entity_id,
      enqueued_at = datetime('now'),
      started_at = NULL,
      attempts = 0,
      last_error = NULL
    RETURNING id
  `;
  return rows[0].id as number;
}

/**
 * Atomically claim the next pending row for a role in a space. Returns
 * null if there's nothing to do. Uses a single UPDATE...RETURNING so
 * two competing claims can't take the same row.
 */
export async function claimNext(
  spaceId: string,
  role: string,
): Promise<QueuedItem | null> {
  const sql = createSql();
  const rows = await sql`
    UPDATE agent_queue
    SET started_at = datetime('now'), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM agent_queue
      WHERE space_id = ${spaceId}
        AND role = ${role}
        AND started_at IS NULL
        AND attempts < ${MAX_QUEUE_ATTEMPTS}
      ORDER BY enqueued_at
      LIMIT 1
    )
    RETURNING *
  `;
  if (rows.length === 0) return null;
  return rowToItem(rows[0]);
}

/** Remove a row from the queue after the agent run completed successfully. */
export async function complete(id: number): Promise<void> {
  const sql = createSql();
  await sql`DELETE FROM agent_queue WHERE id = ${id}`;
}

/**
 * Reset a row to pending after a failed run, recording the error. The
 * next claim will retry. Caller decides when "too many attempts" is a
 * dead letter — we just track the count.
 */
export async function fail(id: number, errorMessage: string): Promise<void> {
  const sql = createSql();
  await sql`
    UPDATE agent_queue
    SET started_at = NULL, last_error = ${errorMessage}
    WHERE id = ${id}
  `;
}

/**
 * Reset rows whose started_at is older than the lease TTL — they
 * belong to a daemon that crashed mid-run. The next claim picks them
 * up. Run on daemon startup. Returns the number of rows reclaimed.
 *
 * Idempotency from agent_runs is the second safety net: if the
 * crashed daemon actually completed the run before crashing (just
 * didn't get to DELETE the queue row), the replay will be a no-op
 * because runAgent's input_hash check skips it.
 */
export async function reclaimOrphans(
  leaseMinutes: number = ORPHAN_LEASE_MINUTES,
): Promise<number> {
  const sql = createSql();
  const cutoff = `-${leaseMinutes} minutes`;
  const rows = await sql`
    UPDATE agent_queue
    SET started_at = NULL,
        last_error = 'reclaimed: lease expired (daemon crash?)'
    WHERE started_at IS NOT NULL
      AND started_at < datetime('now', ${cutoff})
    RETURNING id
  `;
  return rows.length;
}

/** Diagnostic: count pending and in-flight rows per role. */
export async function queueStats(spaceId?: string): Promise<{
  role: string;
  pending: number;
  in_flight: number;
}[]> {
  const sql = createSql();
  const rows = spaceId
    ? await sql`
        SELECT role,
               SUM(CASE WHEN started_at IS NULL THEN 1 ELSE 0 END) AS pending,
               SUM(CASE WHEN started_at IS NOT NULL THEN 1 ELSE 0 END) AS in_flight
        FROM agent_queue
        WHERE space_id = ${spaceId}
        GROUP BY role
      `
    : await sql`
        SELECT role,
               SUM(CASE WHEN started_at IS NULL THEN 1 ELSE 0 END) AS pending,
               SUM(CASE WHEN started_at IS NOT NULL THEN 1 ELSE 0 END) AS in_flight
        FROM agent_queue
        GROUP BY role
      `;
  return rows.map((r) => ({
    role: r.role as string,
    pending: Number(r.pending ?? 0),
    in_flight: Number(r.in_flight ?? 0),
  }));
}

function rowToItem(row: Record<string, unknown>): QueuedItem {
  return {
    id: row.id as number,
    space_id: row.space_id as string,
    role: row.role as string,
    trigger_path: row.trigger_path as string,
    trigger_entity_id: (row.trigger_entity_id as string | null) ?? null,
    enqueued_at: row.enqueued_at as string,
    started_at: (row.started_at as string | null) ?? null,
    attempts: row.attempts as number,
    last_error: (row.last_error as string | null) ?? null,
  };
}
