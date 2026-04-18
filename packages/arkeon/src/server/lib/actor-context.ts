// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { withTransaction, type SqlClient, type createSql } from "./sql";
import type { Actor } from "../types";

/**
 * Returns a single SQL query that sets the RLS session context for an actor.
 * Use as the first query in a transaction: [...setActorContext(sql, actor), ...queries]
 *
 * Sets: app.actor_id
 */
export function setActorContext(sql: ReturnType<typeof createSql>, actor: Actor | null) {
  if (!actor) {
    return [
      sql`SELECT set_config('app.actor_id', '', true)`,
    ];
  }

  return [
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
  ];
}

/**
 * Run a callback in a transaction with RLS session variables set to a
 * synthetic "system" actor.
 *
 * This is for internal, non-user-facing operations — e.g., the
 * background search-index sync and the admin reindex loop.
 *
 * Do NOT use this to bypass RLS on behalf of an authenticated caller.
 * If you find yourself reaching for it on a request path, the right
 * answer is almost always to thread the real actor through instead.
 */
export async function withSystemActorContext<T>(
  fn: (sql: SqlClient) => Promise<T>,
): Promise<T> {
  return withTransaction(async (tx) => {
    await tx`SELECT set_config('app.actor_id', 'system', true)`;
    return fn(tx);
  });
}
