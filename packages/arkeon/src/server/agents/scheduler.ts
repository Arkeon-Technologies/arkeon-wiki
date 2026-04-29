// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-space agent scheduler.
 *
 * Bridges the file watcher and the agent runtime. One scheduler runs
 * per space; for each role configured in that space, it owns a worker
 * loop that:
 *
 *   1. claims the next pending row from agent_queue
 *   2. invokes runAgent under the runtime's per-key concurrency lock
 *   3. on success: deletes the row
 *   4. on failure: clears started_at, records last_error, lets the
 *      next claim retry
 *
 * The watcher calls scheduler.notify() after every relevant file
 * event so the worker wakes immediately instead of waiting for the
 * next poll. Polling is the safety net for missed wakeups (and for
 * orphan reclaim post-crash).
 *
 * v1 keeps things simple: one role (`ingestor`) per space, max 1
 * concurrent run per role. Adding more roles or per-role concurrency
 * caps later is just a config knob — the queue infra already handles
 * multi-role.
 */

import {
  claimNext,
  complete,
  enqueue,
  fail,
  reclaimOrphans,
  type QueuedItem,
} from "../lib/agent-queue.js";
import type { Space } from "../lib/sync.js";

import { loadAgentConfig } from "./config.js";
import { isBuiltinRole } from "./builtins.js";
import { shouldTrigger } from "./path-filter.js";
import { buildAgentRole } from "./role-builder.js";
import { runAgent as defaultRunAgent } from "./runtime.js";
import { ALL_TOOLS } from "./tools.js";

/** Default role to run on source-file events. v1 hardcodes this; when
 *  user-defined triggers land, this becomes a fallback. */
const DEFAULT_TRIGGER_ROLE = "ingestor";

/** How often a worker re-polls the queue when notify() hasn't fired
 *  recently. Mostly a safety net for missed wakeups. */
const POLL_INTERVAL_MS = 2_000;

interface SchedulerHandle {
  notify(relativePath: string, entityId?: string | null): Promise<void>;
  stop(): Promise<void>;
}

export interface StartSchedulerOptions {
  space: Space;
  /** Role to run when a non-wiki file event fires. Defaults to
   *  `ingestor`; set to `null` to disable auto-triggering for this
   *  space (e.g., for a bring-your-own-trigger setup). */
  triggerRole?: string | null;
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
 * Start a scheduler for a space. Returns a handle the watcher uses to
 * notify of file events and the daemon uses to stop on shutdown.
 *
 * Reclaims orphans (rows with stale leases from a previous crashed
 * daemon) on startup.
 */
export async function startScheduler(
  opts: StartSchedulerOptions,
): Promise<SchedulerHandle> {
  const triggerRole = opts.triggerRole ?? DEFAULT_TRIGGER_ROLE;
  const tools = opts.toolRegistry ?? ALL_TOOLS;
  const runAgent = opts.runAgentFn ?? defaultRunAgent;

  // Probe: can we actually build this role from config + env right now?
  // If not (e.g. agents.yaml says provider=openai but OPENAI_API_KEY
  // isn't set), don't start a worker — otherwise it would tight-loop
  // failing on every queued event. Returns a no-op handle so the
  // watcher's call to notify() is a cheap silent skip.
  if (triggerRole) {
    try {
      const config = loadAgentConfig({ spaceDir: opts.space.watch_dir });
      if (!isBuiltinRole(triggerRole) && !config.roles?.[triggerRole]) {
        throw new Error(
          `Role '${triggerRole}' is neither a built-in nor declared in agents.yaml`,
        );
      }
      buildAgentRole(triggerRole, config);
    } catch (err) {
      console.log(
        `[agent/scheduler] not auto-triggering for space "${opts.space.name}": ${(err as Error).message}`,
      );
      return {
        notify: async () => {},
        stop: async () => {},
      };
    }
  }

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

  if (triggerRole) {
    void worker(triggerRole);
  }

  return {
    async notify(relativePath: string, entityId?: string | null) {
      if (!triggerRole) return;
      if (!shouldTrigger(relativePath)) return;
      await enqueue({
        space_id: opts.space.id,
        role: triggerRole,
        trigger_path: relativePath,
        trigger_entity_id: entityId ?? null,
      });
      wakeup();
    },
    async stop() {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      wakeup(); // unblock any pending wait so the loop exits
    },
  };
}
