// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-space cron scheduler.
 *
 * Each role declares a `cron:` expression (5-field unix cron). The
 * scheduler computes the next firing time for every cron-bearing role,
 * sleeps until the soonest one, fires it, then schedules the next tick.
 *
 * Per-space serialization is enforced by an in-process mutex: at most
 * one role can be running in a given space at any time. If a role's
 * tick fires while another role's run is in flight, the new tick
 * queues behind it (`queueSpaceMutex`) and runs as soon as the FIFO
 * head drains — ticks are never dropped to contention. Spaces run
 * independently — two spaces can both have agents running in parallel,
 * they just can't have two agents running concurrently within the
 * same space. The manual `POST /:space/agents/:role/run` route uses
 * the non-queueing `withSpaceMutex` so operator calls still fast-fail
 * with 409 instead of blocking behind a long cron-fired run.
 *
 * There is no event queue, no file-watcher hookup, and no crash-safe
 * lease semantics — a single-daemon model with per-space mutexes
 * doesn't need them. If the daemon dies mid-run the next tick fires
 * fresh.
 *
 * Downtime → missed ticks are dropped. We don't persist last-fire
 * timestamps, so a daemon that's down across N cron firings simply
 * doesn't fire those N ticks; it picks up at the next scheduled
 * instant after restart. This is fine for the question-driven `writer`
 * (each tick observes current state and picks unprocessed sources from
 * scratch — 30 minutes of skipped ticks costs nothing because the next
 * tick still sees the accumulated work). Future operators adding
 * non-idempotent roles need to know this is the contract: at-most-N
 * firings per cron expression, not at-least-N.
 *
 * Config is re-read on every tick (`loadAgentConfig` + `buildAgentRole`
 * inside `fireTick`). The mtime cache in templates.ts makes the per-call
 * cost negligible, and the trade-off is intentional: operator edits to
 * agents.yaml land on the next tick without a daemon restart, matching
 * the "filesystem is source of truth" philosophy. If a deployment ever
 * needs minimum-disk-reads instead of live-edits-pickup, hoist the
 * built role into ScheduledRole at startup.
 */

import { nextTick } from "./cron.js";
import { loadAgentConfig, type AgentConfig } from "./config.js";
import { buildAgentRole } from "./role-builder.js";
import { loadBundledTemplates } from "./templates.js";
import { runAgent as defaultRunAgent } from "./runtime.js";
import { inFlightRole, queueSpaceMutex } from "./space-mutex.js";
import type { Space } from "../lib/sync.js";

import { ALL_TOOLS } from "./tools.js";

interface SchedulerHandle {
  /** Stop scheduling new ticks and wait for any in-flight run to finish
   *  (bounded by `gracePeriodMs`, default 5s). After resolution no
   *  further runs will fire from this scheduler. */
  stop(): Promise<void>;
}

export interface StartSchedulerOptions {
  space: Space;
  /** Restrict scheduling to a subset of roles. Default: every role
   *  declared in agents.yaml or shipped as a bundled template that
   *  resolves to a non-empty `cron:` field. Pass an empty array to
   *  disable scheduling for this space entirely (mainly for tests). */
  scheduleRoles?: string[];
  /** Override the registry (mainly for tests). */
  toolRegistry?: typeof ALL_TOOLS;
  /** Inject a fake `runAgent` for tests. Production: omit (uses the
   *  real runtime). */
  runAgentFn?: typeof defaultRunAgent;
  /** If true, errors from runAgent throw out of the tick (for tests).
   *  Production: false (errors are logged and the next tick is
   *  scheduled normally). */
  rethrow?: boolean;
  /** How long stop() waits for an in-flight run to finish before
   *  returning anyway. Default 5000 ms. */
  gracePeriodMs?: number;
}

interface ScheduledRole {
  role: string;
  cron: string;
}

/**
 * Resolve the cron expression for every role known in this space's
 * config (bundled template overlaid with agents.yaml, with operator
 * `defaults` as the lowest layer). Roles without a cron are silently
 * dropped — they exist as templates but won't auto-run. Same shape as
 * other RoleConfig fields: most-specific-wins.
 */
function collectScheduledRoles(
  config: AgentConfig,
  restrictTo?: string[] | null,
): ScheduledRole[] {
  const templates = loadBundledTemplates();
  const out: ScheduledRole[] = [];
  const allRoles = new Set<string>([
    ...Object.keys(templates),
    ...Object.keys(config.roles ?? {}),
  ]);
  for (const role of allRoles) {
    if (restrictTo && !restrictTo.includes(role)) continue;
    const cron =
      config.roles?.[role]?.cron ??
      templates[role]?.cron ??
      config.defaults?.cron;
    if (cron) out.push({ role, cron });
  }
  return out;
}

/**
 * Start a cron scheduler for a space. Reads the merged agent config,
 * builds every role with a cron expression, and schedules a setTimeout
 * chain per role driven by the cron's next firing time.
 *
 * Returns a handle the daemon uses to stop on shutdown.
 */
export async function startScheduler(
  opts: StartSchedulerOptions,
): Promise<SchedulerHandle> {
  const tools = opts.toolRegistry ?? ALL_TOOLS;
  const runAgent = opts.runAgentFn ?? defaultRunAgent;
  const gracePeriodMs = opts.gracePeriodMs ?? 5_000;

  // Discover every role with a cron and drop those that won't build
  // (missing API key, etc.). Failing roles log once at startup; no
  // further scheduling.
  const config = loadAgentConfig({ spaceDir: opts.space.watch_dir });
  const candidates = collectScheduledRoles(
    config,
    opts.scheduleRoles ?? null,
  );
  const active: ScheduledRole[] = [];
  for (const entry of candidates) {
    try {
      buildAgentRole(entry.role, config);
      active.push(entry);
    } catch (err) {
      console.log(
        `[agent/scheduler] not scheduling role '${entry.role}' for space "${opts.space.name}": ${(err as Error).message}`,
      );
    }
  }

  if (active.length === 0) {
    return { stop: async () => {} };
  }

  // The per-space mutex lives in space-mutex.ts so the manual
  // `POST /:space/agents/:role/run` route obeys the same serialization
  // as cron-fired ticks. `inFlight` here tracks our own most-recent
  // run promise so stop() can wait for it bounded by gracePeriodMs.
  let inFlight: Promise<unknown> | null = null;

  let stopped = false;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleNext(role: string, cron: string): void {
    if (stopped) return;
    let nextAt: Date;
    try {
      nextAt = nextTick(cron, new Date());
    } catch (err) {
      // Validation runs at config load, but a defensive belt-and-braces
      // catch here means a future programmatic config edit can't crash
      // the daemon mid-flight.
      console.error(
        `[agent/scheduler] role=${role} cron='${cron}' invalid at runtime: ${(err as Error).message}`,
      );
      return;
    }
    const delayMs = Math.max(0, nextAt.getTime() - Date.now());
    const timer = setTimeout(() => {
      timers.delete(role);
      if (stopped) return;
      void fireTick(role, cron);
    }, delayMs);
    timers.set(role, timer);
  }

  async function fireTick(role: string, cron: string): Promise<void> {
    const built = (() => {
      try {
        return buildAgentRole(role, loadAgentConfig({ spaceDir: opts.space.watch_dir }));
      } catch (err) {
        console.error(
          `[agent/scheduler] role=${role} buildAgentRole failed: ${(err as Error).message}`,
        );
        return null;
      }
    })();
    if (!built) {
      scheduleNext(role, cron);
      return;
    }

    // `queueSpaceMutex` orders cron ticks behind any in-flight or
    // already-queued run in this space (FIFO). The manual HTTP route
    // uses the non-queueing `withSpaceMutex`, so an operator call
    // still 409s instead of blocking — and from this side, an HTTP
    // run holding the mutex just means our queue entry waits one more
    // hop. Two cron timers firing in the same JS tick are ordered by
    // the order they call `queueSpaceMutex`, which matches the order
    // their `setTimeout` callbacks fire.
    const blockingRole = inFlightRole(opts.space.name);
    if (blockingRole && blockingRole !== role) {
      console.log(
        `[agent/scheduler] role=${role} space="${opts.space.name}" queued behind ${blockingRole}`,
      );
    }
    const queuedAt = Date.now();
    const runPromise = queueSpaceMutex(opts.space.name, role, async () => {
      const waitedMs = Date.now() - queuedAt;
      if (waitedMs >= 100) {
        console.log(
          `[agent/scheduler] role=${role} space="${opts.space.name}" running (waited ${waitedMs}ms in queue)`,
        );
      }
      try {
        await runAgent(
          built,
          { space: opts.space, meta: {} },
          tools,
          {},
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[agent/scheduler] role=${role} space="${opts.space.name}" failed: ${msg}`,
        );
        if (opts.rethrow) throw err;
      }
    });
    inFlight = runPromise;

    try {
      await runPromise;
    } finally {
      inFlight = null;
      scheduleNext(role, cron);
    }
  }

  // Kick off the chain for every active role.
  for (const { role, cron } of active) {
    scheduleNext(role, cron);
  }

  return {
    async stop() {
      stopped = true;
      for (const [, timer] of timers) clearTimeout(timer);
      timers.clear();
      if (!inFlight) return;
      // Bounded grace: don't hang the daemon shutdown if a model call
      // is taking forever to stream — let it leak and exit. The agent
      // process is going down anyway.
      await Promise.race([
        inFlight,
        new Promise<void>((r) => setTimeout(r, gracePeriodMs)),
      ]);
    },
  };
}
