// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-space agent scheduler.
 *
 * Bridges the file watcher and the agent runtime. One scheduler runs
 * per space and owns a worker loop per role that has any declared
 * trigger. Each worker:
 *
 *   1. claims the next pending row from agent_queue
 *   2. invokes runAgent under the runtime's per-key concurrency lock
 *   3. on success: deletes the row
 *   4. on failure: clears started_at, records last_error, lets the
 *      next claim retry
 *
 * The watcher calls scheduler.notify() after every file event. The
 * scheduler walks every role's compiled triggers, finds the ones whose
 * path globs and by_role filters match, and enqueues a row for each.
 * Polling is the safety net for missed wakeups (and for orphan
 * reclaim post-crash).
 */

import {
  claimNext,
  complete,
  enqueue,
  fail,
  reclaimOrphans,
  type QueuedItem,
} from "../lib/agent-queue.js";
import { createSql } from "../lib/sql.js";
import type { Space } from "../lib/sync.js";

import {
  loadAgentConfig,
  type AgentConfig,
  type TriggerCondition,
} from "./config.js";
import { BUILTIN_ROLES, isBuiltinRole } from "./builtins.js";
import { buildAgentRole } from "./role-builder.js";
import { runAgent as defaultRunAgent } from "./runtime.js";
import { ALL_TOOLS } from "./tools.js";
import {
  compileRoleTriggers,
  rolesToFire,
  type RoleTrigger,
} from "./triggers.js";

/** How often a worker re-polls the queue when notify() hasn't fired
 *  recently. Mostly a safety net for missed wakeups. */
const POLL_INTERVAL_MS = 2_000;

interface SchedulerHandle {
  notify(relativePath: string, entityId?: string | null): Promise<void>;
  stop(): Promise<void>;
}

export interface StartSchedulerOptions {
  space: Space;
  /** Restrict auto-triggering to a subset of roles. By default the
   *  scheduler walks every role declared in agents.yaml plus every
   *  built-in role with default triggers, and fires whichever match.
   *  Pass an explicit role list to limit (mainly for tests). Pass an
   *  empty array to disable auto-triggering for this space entirely. */
  triggerRoles?: string[];
  /** Override the registry (mainly for tests). */
  toolRegistry?: typeof ALL_TOOLS;
  /** Inject a fake `runAgent` for tests. Production: omit (uses the
   *  real runtime). The fake receives the fully-built AgentRole, the
   *  AgentInput, and the tool registry. */
  runAgentFn?: typeof defaultRunAgent;
  /** If true, errors from runAgent throw out of the worker (for tests).
   *  Production: false (errors stay in agent_queue.last_error). */
  rethrow?: boolean;
}

/**
 * Walk every role known in this space's config (built-ins overlaid
 * with agents.yaml) and gather their declared triggers. Built-in roles
 * keep their default triggers unless the user supplied their own; a
 * user-supplied `triggers` array (including the empty array) replaces
 * the built-in default wholesale.
 */
function collectRoleTriggers(
  config: AgentConfig,
  restrictTo?: string[] | null,
): Array<{ role: string; triggers: TriggerCondition[] }> {
  const out: Array<{ role: string; triggers: TriggerCondition[] }> = [];
  const allRoles = new Set<string>([
    ...Object.keys(BUILTIN_ROLES),
    ...Object.keys(config.roles ?? {}),
  ]);
  for (const role of allRoles) {
    if (restrictTo && !restrictTo.includes(role)) continue;
    const fromConfig = config.roles?.[role]?.triggers;
    const fromBuiltin = isBuiltinRole(role)
      ? BUILTIN_ROLES[role].triggers
      : undefined;
    const triggers = fromConfig ?? fromBuiltin ?? [];
    if (triggers.length > 0) out.push({ role, triggers });
  }
  return out;
}

/**
 * Read the latest `entity_edits.by_role` for the entity at this path,
 * if any. Used by the trigger evaluator to apply attribution filters.
 * Returns null when no entity_edits row exists yet.
 */
async function lookupLatestByRole(
  spaceId: string,
  relativePath: string,
): Promise<string | null> {
  const sql = createSql();
  const rows = (await sql`
    SELECT le.last_edited_by AS by_role
    FROM entities e
    JOIN entity_latest_edit le ON le.entity_id = e.id
    WHERE e.space_id = ${spaceId} AND e.source_path = ${relativePath}
    LIMIT 1
  `) as { by_role: string }[];
  return rows.length > 0 ? rows[0].by_role : null;
}

/**
 * Start a scheduler for a space. Returns a handle the watcher uses to
 * notify of file events and the daemon uses to stop on shutdown.
 *
 * Reclaims orphans (rows with stale leases from a previous crashed
 * daemon) on startup.
 */
export async function startScheduler(
  opts: StartSchedulerOptions,
): Promise<SchedulerHandle> {
  const tools = opts.toolRegistry ?? ALL_TOOLS;
  const runAgent = opts.runAgentFn ?? defaultRunAgent;

  // Collect every role with at least one declared trigger, then probe
  // each: can we actually build it from config + env right now? If
  // not (e.g. agents.yaml says provider=openai but OPENAI_API_KEY
  // isn't set), drop the role from the active set so it doesn't
  // tight-loop failing on every queued event. The watcher's notify()
  // becomes a silent skip for any role that didn't pass probe.
  const config = loadAgentConfig({ spaceDir: opts.space.watch_dir });
  const allRoleTriggers = collectRoleTriggers(
    config,
    opts.triggerRoles ?? null,
  );
  const activeRoles: string[] = [];
  const usableRoleTriggers: typeof allRoleTriggers = [];
  for (const { role, triggers } of allRoleTriggers) {
    try {
      buildAgentRole(role, config);
      activeRoles.push(role);
      usableRoleTriggers.push({ role, triggers });
    } catch (err) {
      console.log(
        `[agent/scheduler] not auto-triggering role '${role}' for space "${opts.space.name}": ${(err as Error).message}`,
      );
    }
  }

  if (activeRoles.length === 0) {
    return {
      notify: async () => {},
      stop: async () => {},
    };
  }

  const compiledTriggers: RoleTrigger[] = compileRoleTriggers(usableRoleTriggers);

  await reclaimOrphans();

  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  // Wakeup channel — flag-based to avoid the race where notify()
  // arrives between the worker resolving its wait and creating the
  // next one. `wakeupPending` is set by notify() and cleared by the
  // worker after it observes the wakeup. If a notify lands while
  // wakeupResolve is null, the flag remains true; the next loop pass
  // sees it and skips the wait entirely.
  let wakeupPending = false;
  let wakeupResolve: (() => void) | null = null;

  function nextWakeup(): Promise<void> {
    return new Promise<void>((resolve) => {
      // If a notify arrived while we were busy, fast-path: resolve
      // immediately and clear the flag.
      if (wakeupPending) {
        wakeupPending = false;
        resolve();
        return;
      }
      wakeupResolve = resolve;
    });
  }

  function wakeup(): void {
    wakeupPending = true;
    if (wakeupResolve) {
      const r = wakeupResolve;
      wakeupResolve = null;
      wakeupPending = false;
      r();
    }
  }

  // Worker loop. One per role; v1 only runs the default trigger role
  // if it's set. Wraps each iteration in try/catch so a transient DB
  // error (connection blip, etc.) doesn't permanently kill the
  // worker — we log, back off, and retry.
  const ERROR_BACKOFF_MS = 5_000;
  async function worker(role: string): Promise<void> {
    while (!stopped) {
      try {
        const item = await claimNext(opts.space.id, role);
        if (item) {
          await runOne(item);
          // Continue immediately; there may be more pending.
          continue;
        }
        // Nothing pending; wait for a notification or the poll tick.
        await Promise.race([
          nextWakeup(),
          new Promise<void>((r) => {
            pollTimer = setTimeout(r, POLL_INTERVAL_MS);
          }),
        ]);
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
      } catch (err) {
        // Errors here are infrastructure-level (database hiccup,
        // unexpected throw from claimNext). runOne handles its own
        // failures via the agent_queue row. Back off and retry so we
        // don't spin and don't die silently.
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[agent/scheduler] role=${role} worker loop error: ${message}`,
        );
        await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
      }
    }
  }

  async function runOne(item: QueuedItem): Promise<void> {
    try {
      const config = loadAgentConfig({ spaceDir: opts.space.watch_dir });
      // The role must exist as a built-in or in YAML.
      if (!isBuiltinRole(item.role) && !config.roles?.[item.role]) {
        await fail(item.id, `unknown role '${item.role}'`);
        return;
      }
      const role = buildAgentRole(item.role, config);

      await runAgent(
        role,
        {
          space: opts.space,
          triggerPath: item.trigger_path,
          triggerEntityId: item.trigger_entity_id ?? undefined,
        },
        tools,
        {},
      );
      await complete(item.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Log to stdout; the daemon log captures this.
      console.error(
        `[agent/scheduler] role=${item.role} path=${item.trigger_path} attempt=${item.attempts} failed: ${message}`,
      );
      await fail(item.id, message);
      if (opts.rethrow) throw err;
    }
  }

  // Spawn one worker loop per active role. Each pulls from its own
  // role-scoped queue partition.
  for (const role of activeRoles) {
    void worker(role);
  }

  return {
    async notify(relativePath: string, entityId?: string | null) {
      // Look up who most recently edited this entity so attribution
      // filters can be applied. If no entity_edits row exists yet
      // (first observation of a brand-new file), by_role is null.
      const byRole = await lookupLatestByRole(opts.space.id, relativePath);
      const fired = rolesToFire(compiledTriggers, {
        path: relativePath,
        by_role: byRole,
      });
      for (const role of fired) {
        await enqueue({
          space_id: opts.space.id,
          role,
          trigger_path: relativePath,
          trigger_entity_id: entityId ?? null,
        });
      }
      if (fired.length > 0) wakeup();
    },
    async stop() {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      wakeup(); // unblock any pending wait so the loop exits
    },
  };
}
