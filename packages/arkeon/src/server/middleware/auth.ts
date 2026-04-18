// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MiddlewareHandler } from "hono";

import { extractApiKey, sha256Hex } from "../lib/auth";
import { backgroundTask } from "../lib/background";
import { createSql } from "../lib/sql";
import type { Actor, AppBindings } from "../types";

export const authMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  c.set("actor", null);

  const path = new URL(c.req.url).pathname;
  if (path === "/health" || path === "/ready" || path === "/explore" || path.startsWith("/explore/")) {
    await next();
    return;
  }

  const apiKey = extractApiKey(c.req.header("authorization"), c.req.header("x-api-key"));
  if (!apiKey) {
    await next();
    return;
  }

  const keyHash = await sha256Hex(apiKey);
  const sql = createSql();

  // Look up key and join with actors table
  const [, keyRows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', '', true)`,
    sql`
      SELECT k.id AS key_id, k.actor_id, k.key_prefix,
             a.status,
             a.properties->>'label' AS label
      FROM api_keys k
      JOIN actors a ON a.id = k.actor_id
      WHERE k.key_hash = ${keyHash}
        AND k.revoked_at IS NULL
        AND a.status = 'active'
      LIMIT 1
    `,
  ]);

  const row = (keyRows as Array<{
    key_id: string;
    actor_id: string;
    key_prefix: string;
    status: string;
    label: string | null;
  }>)[0];

  if (!row) {
    await next();
    return;
  }

  const actor: Actor = {
    id: row.actor_id,
    apiKeyId: row.key_id,
    keyPrefix: row.key_prefix,
    label: row.label,
  };

  c.set("actor", actor);

  // Background update last_used_at
  backgroundTask(
    sql.transaction([
      sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
      sql`UPDATE api_keys SET last_used_at = NOW() WHERE id = ${actor.apiKeyId}`,
    ]).then(() => undefined),
  );

  await next();
};
