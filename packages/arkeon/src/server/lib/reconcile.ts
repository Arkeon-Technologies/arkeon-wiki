// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reconcile = re-walk the watched root + re-sync everything found + prune
 * artifact rows whose files are gone. Same code path that runs once at
 * startup; exposed here so the live daemon can heal from dropped watcher
 * events without a restart.
 *
 * Why this exists: `node:fs.watch` on macOS (FSEvents) and Docker-Desktop
 * bind mounts silently drop events under bulk filesystem load. A `mv
 * *.html corpus/` on a few thousand files can leave the index believing
 * some of those files still live at the old paths. We can't detect the
 * drop from the watcher signal alone, so reconcile is the source of
 * correctness — both as a periodic background sweep (default every 30s)
 * and as a force-now button via POST /reconcile.
 *
 * Single-flight: concurrent callers coalesce onto one in-progress
 * reconcile. The first caller drives the work; later callers await the
 * same promise and get `coalesced: true` so they can tell their result
 * came from a sibling call.
 */

import { syncDirectory } from "./sync.js";
import { walkEligibleFiles } from "./fs-watcher.js";

export interface ReconcileSummary {
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  took_ms: number;
  /**
   * False for the call that actually ran the sweep; true for callers
   * that arrived while the sweep was already in flight and rode the
   * same promise. Lets harnesses distinguish "I forced a sweep" from
   * "a sweep was already happening anyway."
   */
  coalesced: boolean;
}

interface InFlight {
  promise: Promise<Omit<ReconcileSummary, "coalesced">>;
}

let inFlight: InFlight | null = null;

/**
 * Run one reconcile pass against `watchedRoot`. If a pass is already
 * running, await it instead of starting a second one — the file system
 * just got walked; running again immediately would be wasted work.
 */
export async function reconcile(watchedRoot: string): Promise<ReconcileSummary> {
  if (inFlight) {
    const summary = await inFlight.promise;
    return { ...summary, coalesced: true };
  }

  const promise = runReconcile(watchedRoot);
  inFlight = { promise };
  try {
    const summary = await promise;
    return { ...summary, coalesced: false };
  } finally {
    inFlight = null;
  }
}

async function runReconcile(
  watchedRoot: string,
): Promise<Omit<ReconcileSummary, "coalesced">> {
  const t0 = Date.now();
  const files = walkEligibleFiles(watchedRoot);
  const summary = await syncDirectory(watchedRoot, files);
  return {
    created: summary.created,
    updated: summary.updated,
    unchanged: summary.unchanged,
    removed: summary.removed,
    took_ms: Date.now() - t0,
  };
}

// ── Periodic sweep ────────────────────────────────────────────────

/**
 * Default sweep interval. 30s is the trade-off: fast enough that a
 * user editing a corpus in a terminal won't notice index drift, slow
 * enough that the stat-walk it triggers (one existsSync per artifact
 * row) is negligible.
 */
export const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;

let periodicTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Read the configured sweep interval from env. Returns 0 when the
 * sweep is explicitly disabled, otherwise a positive ms value.
 *
 *   - unset → default
 *   - "0"   → disabled
 *   - "<n>" → n seconds (clamped to >=1)
 *   - garbage → default + warning
 */
export function resolveReconcileIntervalMs(
  envValue: string | undefined,
  defaultMs = DEFAULT_RECONCILE_INTERVAL_MS,
): number {
  if (envValue === undefined || envValue === "") return defaultMs;
  if (envValue === "0") return 0;
  const n = Number(envValue);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(
      `[watcher] ignoring invalid ARKEON_WIKI_RECONCILE_INTERVAL_SECONDS=${JSON.stringify(envValue)}; using default ${defaultMs / 1000}s`,
    );
    return defaultMs;
  }
  // Clamp tiny positives to 1s — anything smaller is almost certainly
  // a misconfiguration that would peg CPU.
  return Math.max(1000, Math.floor(n * 1000));
}

/**
 * Start the background reconcile loop. The first sweep fires
 * `intervalMs` from now, not immediately — startup already ran one
 * reconcile pass, and double-firing on the same DB rows for no reason
 * just inflates the log.
 *
 * Safe to call multiple times: a second call replaces any prior
 * interval (used by tests that re-init the watcher in the same
 * process).
 */
export function startPeriodicReconcile(
  watchedRoot: string,
  intervalMs: number,
): void {
  stopPeriodicReconcile();
  if (intervalMs <= 0) return;
  const timer = setInterval(() => {
    void runPeriodicSweep(watchedRoot);
  }, intervalMs);
  // Don't let the periodic timer keep the process alive on its own.
  // The watcher / HTTP server own the event loop; this just rides
  // alongside.
  timer.unref?.();
  periodicTimer = timer;
}

export function stopPeriodicReconcile(): void {
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
}

/**
 * One tick of the periodic loop. Errors are swallowed (and logged)
 * so a transient failure doesn't kill the loop — the next tick
 * tries again.
 */
async function runPeriodicSweep(watchedRoot: string): Promise<void> {
  try {
    const summary = await reconcile(watchedRoot);
    // Only log when the sweep did real work. A healthy corpus
    // produces all-zeros except `unchanged`, and printing a line
    // every 30s would just be noise in the daemon log.
    if (
      !summary.coalesced &&
      summary.created + summary.updated + summary.removed > 0
    ) {
      console.log(
        `[reconcile] periodic sweep: ${summary.created} created, ${summary.updated} updated, ${summary.removed} removed (${summary.took_ms}ms)`,
      );
    }
  } catch (err) {
    console.error(
      `[reconcile] periodic sweep failed: ${(err as Error).message}`,
    );
  }
}

// Test-only helper: assert no reconcile is currently in flight. Used to
// guard against test bleed-through between suites.
export function __isReconcileInFlight(): boolean {
  return inFlight !== null;
}
