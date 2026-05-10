// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolves a role's `spaces:` config (names / ids / "self" / "*") into
 * the concrete Space[] the agent context will expose to tools.
 *
 * Resolution rules:
 *   - "self"   → the triggering space.
 *   - "*"      → every registered space. Mutually exclusive with named
 *                entries (mixing them is almost always a config bug; we
 *                accept "*" alone or with `self` and ignore other names
 *                if `*` is present).
 *   - id       → matched against `spaces.id` first. Exact, unambiguous.
 *   - name     → matched against `spaces.name`. If multiple spaces share
 *                the name, throw with the candidate ids — the operator
 *                must disambiguate by id.
 *
 * The triggering space is always present in the result, even if not
 * mentioned explicitly. Operators rarely want a role that can't see its
 * own space.
 *
 * Output is deduplicated and order-preserving (own space first, then
 * additional entries in YAML order).
 */

import type { SqlClient } from "../lib/sql.js";
import { createSql } from "../lib/sql.js";
import type { Space } from "../lib/sync.js";

export const DEFAULT_SCOPE: readonly string[] = ["self"];

interface SpaceRow {
  id: string;
  name: string;
  watch_dir: string;
}

export interface ResolveScopeOptions {
  /** Inject a sql client for tests. Production: omit. */
  sql?: SqlClient;
}

/**
 * Resolve the configured scope into the concrete Space[] the agent
 * is allowed to read from. The triggering space is implicitly
 * included.
 *
 * Throws on:
 *   - unknown name/id
 *   - ambiguous name (multiple spaces with the same name)
 *
 * The error messages are written for operators reading daemon logs —
 * agents don't see them.
 */
export async function resolveAllowedSpaces(
  scope: readonly string[] | undefined,
  ownSpace: Space,
  options: ResolveScopeOptions = {},
): Promise<Space[]> {
  const sql = options.sql ?? createSql();
  const requested = scope && scope.length > 0 ? scope : DEFAULT_SCOPE;

  // "*" wins. Trim every other entry except a redundant "self" since the
  // result already includes every space.
  if (requested.includes("*")) {
    const rows = (await sql`
      SELECT id, name, watch_dir FROM spaces
      WHERE watch_dir IS NOT NULL
    `) as unknown as SpaceRow[];
    return orderResult(ownSpace, rows);
  }

  // Build a stable index for name/id lookups in one pass.
  const allRows = (await sql`
    SELECT id, name, watch_dir FROM spaces
    WHERE watch_dir IS NOT NULL
  `) as unknown as SpaceRow[];

  const byId = new Map<string, SpaceRow>();
  const byName = new Map<string, SpaceRow[]>();
  for (const row of allRows) {
    byId.set(row.id, row);
    const list = byName.get(row.name);
    if (list) {
      list.push(row);
    } else {
      byName.set(row.name, [row]);
    }
  }

  const picked: SpaceRow[] = [];
  const seen = new Set<string>();

  // Always include the triggering space first. The "self" alias maps
  // here; explicit ids/names that match it dedupe via `seen`.
  if (!seen.has(ownSpace.id)) {
    picked.push({
      id: ownSpace.id,
      name: ownSpace.name,
      watch_dir: ownSpace.watch_dir,
    });
    seen.add(ownSpace.id);
  }

  for (const entry of requested) {
    if (entry === "self") continue; // already covered

    // Try id match first. Ids are ULIDs (26 chars, alnum) so the
    // namespace is effectively disjoint from human names; an id-shaped
    // string that happens to also be a name is a non-issue in practice.
    const idHit = byId.get(entry);
    if (idHit) {
      if (!seen.has(idHit.id)) {
        picked.push(idHit);
        seen.add(idHit.id);
      }
      continue;
    }

    const nameHits = byName.get(entry) ?? [];
    if (nameHits.length === 0) {
      throw new Error(
        `agents.yaml spaces: '${entry}' did not match any registered space ` +
          `(neither id nor name). Run 'arkeon-wiki ls' to see registered spaces.`,
      );
    }
    if (nameHits.length > 1) {
      const ids = nameHits.map((r) => r.id).join(", ");
      throw new Error(
        `agents.yaml spaces: name '${entry}' is ambiguous — ` +
          `${nameHits.length} registered spaces share that name. ` +
          `Use one of the following ids instead: ${ids}.`,
      );
    }
    const hit = nameHits[0];
    if (!seen.has(hit.id)) {
      picked.push(hit);
      seen.add(hit.id);
    }
  }

  return picked.map(toSpace);
}

function orderResult(ownSpace: Space, rows: SpaceRow[]): Space[] {
  const own: Space = {
    id: ownSpace.id,
    name: ownSpace.name,
    watch_dir: ownSpace.watch_dir,
  };
  const others: Space[] = [];
  for (const row of rows) {
    if (row.id === ownSpace.id) continue;
    others.push(toSpace(row));
  }
  return [own, ...others];
}

function toSpace(row: SpaceRow): Space {
  return { id: row.id, name: row.name, watch_dir: row.watch_dir };
}

/**
 * Resolve a tool's `space` argument — accepting either a space name or
 * an id — against the agent's allowed set. Returns the matched Space
 * or throws with a tool-friendly error message (the agent sees these).
 *
 * Ambiguous names within the allowed set are flagged with the candidate
 * ids so the agent can re-issue the call disambiguating by id. This
 * mirrors the operator-facing behavior in resolveAllowedSpaces but at
 * the per-call layer where the LLM gets the feedback.
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
  const idHit = allowed.find((s) => s.id === trimmed);
  if (idHit) return idHit;
  const nameHits = allowed.filter((s) => s.name === trimmed);
  if (nameHits.length === 1) return nameHits[0];
  if (nameHits.length > 1) {
    const ids = nameHits.map((s) => s.id).join(", ");
    throw new Error(
      `space '${trimmed}' is ambiguous — ${nameHits.length} allowed spaces ` +
        `share that name. Pass one of these ids instead: ${ids}.`,
    );
  }
  throw new Error(
    `space '${trimmed}' is not in the allowed set for this role. ` +
      `Allowed: ${describeAllowed(allowed)}.`,
  );
}

/**
 * Compact "name (id)" listing of the allowed set, suitable for
 * embedding in tool error messages and tool descriptions so the LLM
 * sees what's available.
 */
export function describeAllowed(allowed: readonly Space[]): string {
  if (allowed.length === 0) return "(none)";
  return allowed.map((s) => `${s.name} (${s.id})`).join(", ");
}
