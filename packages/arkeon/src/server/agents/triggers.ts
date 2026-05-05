// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Trigger evaluation: given a file_changed event and a set of role
 * configurations, decide which roles should fire.
 *
 * The legacy hardcoded path filter (path-filter.ts, the single global
 * "no wiki/**, no .arkeon/**" rule) is replaced by per-role declarative
 * triggers in agents.yaml. Each role declares one or more conditions;
 * any matching condition enqueues a run.
 *
 * Three filter axes per condition:
 *   - path globs: `path_under` (must match) and `path_not_under`
 *     (must not match) — picomatch-style globs.
 *   - attribution: `by_role` (positive — only these), `by_role_not`
 *     (negative — never these). Loop safety idiom is for a worker to
 *     list its own role in `by_role_not` so it doesn't fire on its
 *     own writes.
 *
 * The path-filter.ts module is deleted in this commit; what remains
 * here is its declarative replacement.
 */

import picomatch from "picomatch";

import type { TriggerCondition } from "./config.js";

export interface FileChangedEvent {
  /** Path relative to the space's watch_dir, with forward slashes. */
  path: string;
  /** Role attribution from entity_edits.by_role for the most recent
   *  edit on the entity at this path. `null` if no entity_edits row
   *  exists yet (e.g. the very first time a file is observed). The
   *  scheduler is responsible for looking this up before evaluating
   *  triggers. */
  by_role: string | null;
}

/**
 * Pre-compile a condition's globs into matcher functions. Picomatch
 * is faster on repeated matches when patterns are pre-compiled, and
 * the scheduler evaluates triggers on every file event.
 */
interface CompiledCondition {
  matchUnder: (p: string) => boolean;
  matchNotUnder: (p: string) => boolean;
  by_role?: Set<string>;
  by_role_not?: Set<string>;
}

export function compileCondition(c: TriggerCondition): CompiledCondition {
  return {
    matchUnder: picomatch(c.path_under, { dot: true }),
    matchNotUnder: c.path_not_under
      ? picomatch(c.path_not_under, { dot: true })
      : () => false,
    by_role: c.by_role ? new Set(c.by_role) : undefined,
    by_role_not: c.by_role_not ? new Set(c.by_role_not) : undefined,
  };
}

/**
 * Does this single condition match this event?
 *
 * Order:
 *   1. path must satisfy path_under
 *   2. path must NOT satisfy path_not_under
 *   3. by_role (positive) must contain the event's by_role if set
 *   4. by_role_not must NOT contain the event's by_role if set
 *
 * `null` by_role (no prior edit) is treated as not matching any role
 * filter — it's neither in `by_role` nor in `by_role_not`. Result:
 * positive `by_role: ["ingestor"]` rejects the null event, while
 * `by_role_not: ["synthesizer"]` accepts it.
 */
export function matches(c: CompiledCondition, e: FileChangedEvent): boolean {
  if (!c.matchUnder(e.path)) return false;
  if (c.matchNotUnder(e.path)) return false;

  if (c.by_role && (e.by_role === null || !c.by_role.has(e.by_role))) {
    return false;
  }
  if (c.by_role_not && e.by_role !== null && c.by_role_not.has(e.by_role)) {
    return false;
  }
  return true;
}

/**
 * Compile all triggers for all roles once at scheduler startup.
 * Returns a list of (roleName, condition) pairs the scheduler walks
 * for each event. We don't index the conditions by role at this layer
 * — the scheduler decides what to do with each match.
 */
export interface RoleTrigger {
  role: string;
  condition: CompiledCondition;
}

export function compileRoleTriggers(
  rolesWithTriggers: Array<{ role: string; triggers: TriggerCondition[] }>,
): RoleTrigger[] {
  const out: RoleTrigger[] = [];
  for (const { role, triggers } of rolesWithTriggers) {
    for (const trigger of triggers) {
      out.push({ role, condition: compileCondition(trigger) });
    }
  }
  return out;
}

/**
 * Evaluate every compiled trigger against an event; return the role
 * names that should fire. Same role can appear multiple times if it
 * has multiple matching conditions; deduplicate before enqueuing.
 */
export function rolesToFire(
  triggers: RoleTrigger[],
  event: FileChangedEvent,
): string[] {
  const fired = new Set<string>();
  for (const t of triggers) {
    if (matches(t.condition, event)) fired.add(t.role);
  }
  return [...fired];
}
