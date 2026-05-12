// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolves a role's `spaces:` config (names / "self" / "*") into the
 * concrete Space[] the agent context will expose to tools.
 *
 *   - "self"   → the triggering space.
 *   - "*"      → every registered space. Mutually exclusive with named
 *                entries except for "self".
 *   - name     → matched against `spaces.name` (now the PK, so always
 *                unique). Unknown names throw.
 *
 * The triggering space is always present in the result, even if not
 * mentioned explicitly. Operators rarely want a role that can't see
 * its own space.
 *
 * Output is deduplicated and order-preserving (own space first, then
 * additional entries in YAML order).
 */

import type { SqlClient } from "../lib/sql.js";
import { createSql } from "../lib/sql.js";
import type { Space } from "../lib/sync.js";

export const DEFAULT_SCOPE: readonly string[] = ["self"];

interface SpaceRow {
  name: string;
  watch_dir: string;
}

export interface ResolveScopeOptions {
  /** Inject a sql client for tests. Production: omit. */
  sql?: SqlClient;
}

export async function resolveAllowedSpaces(
  scope: readonly string[] | undefined,
  ownSpace: Space,
  options: ResolveScopeOptions = {},
): Promise<Space[]> {
  const sql = options.sql ?? createSql();
  const requested = scope && scope.length > 0 ? scope : DEFAULT_SCOPE;

  if (requested.includes("*")) {
    const noisy = requested.filter((e) => e !== "*" && e !== "self");
    if (noisy.length > 0) {
      throw new Error(
        `agents.yaml spaces: "*" cannot be combined with named entries ` +
          `(${noisy.map((s) => `'${s}'`).join(", ")}). ` +
          `Use ["*"] alone for global scope, or list the spaces explicitly without "*".`,
      );
    }
    const rows = (await sql`
      SELECT name, watch_dir FROM spaces
      WHERE watch_dir IS NOT NULL
    `) as unknown as SpaceRow[];
    return orderResult(ownSpace, rows);
  }

  const allRows = (await sql`
    SELECT name, watch_dir FROM spaces
    WHERE watch_dir IS NOT NULL
  `) as unknown as SpaceRow[];

  const byName = new Map<string, SpaceRow>();
  for (const row of allRows) byName.set(row.name, row);

  const picked: SpaceRow[] = [];
  const seen = new Set<string>();

  // Always include the triggering space first. "self" resolves here.
  picked.push({ name: ownSpace.name, watch_dir: ownSpace.watch_dir });
  seen.add(ownSpace.name);

  for (const entry of requested) {
    if (entry === "self") continue;
    const hit = byName.get(entry);
    if (!hit) {
      throw new Error(
        `agents.yaml spaces: '${entry}' did not match any registered space. ` +
          `Run 'arkeon-wiki ls' to see registered spaces.`,
      );
    }
    if (!seen.has(hit.name)) {
      picked.push(hit);
      seen.add(hit.name);
    }
  }

  return picked;
}

function orderResult(ownSpace: Space, rows: SpaceRow[]): Space[] {
  const own: Space = { name: ownSpace.name, watch_dir: ownSpace.watch_dir };
  const others: Space[] = [];
  for (const row of rows) {
    if (row.name === ownSpace.name) continue;
    others.push(row);
  }
  return [own, ...others];
}

/**
 * Resolve a tool's `space` argument against the agent's allowed set.
 * Returns the matched Space or throws with a tool-friendly error
 * message (the agent sees these).
 */
export function resolveSpaceArg(
  arg: string,
  allowed: readonly Space[],
): Space {
  const trimmed = arg.trim();
  if (!trimmed) {
    throw new Error(
      `space argument cannot be empty. Allowed spaces: ${describeAllowed(allowed)}.`,
    );
  }
  const hit = allowed.find((s) => s.name === trimmed);
  if (hit) return hit;
  throw new Error(
    `space '${trimmed}' is not in the allowed set for this role. ` +
      `Allowed: ${describeAllowed(allowed)}.`,
  );
}

export function describeAllowed(allowed: readonly Space[]): string {
  if (allowed.length === 0) return "(none)";
  return allowed.map((s) => s.name).join(", ");
}
