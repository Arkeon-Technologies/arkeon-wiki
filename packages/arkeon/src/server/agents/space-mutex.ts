// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-space agent mutex, shared between the cron scheduler and any
 * other caller that needs to run a role in a space (today: the manual
 * `POST /:space/agents/:role/run` endpoint).
 *
 * Process-global Map keyed by space name. At most one role runs per
 * space at a time. Callers race-free in the single-threaded Node
 * model: `inFlight.set` happens synchronously before any await, so
 * two timers firing in the same JS tick are serialized correctly.
 *
 * Two acquire paths, same one-runner-per-space invariant:
 *
 * - `withSpaceMutex` — fail-fast. Throws `SpaceBusyError` synchronously
 *   if the space is busy OR has a queued waiter. The HTTP route
 *   `POST /:space/agents/:role/run` uses this so operator-driven calls
 *   return 409 immediately instead of blocking on a long cron-fired run.
 *
 * - `queueSpaceMutex` — wait-in-line. Chains onto a per-space FIFO tail
 *   promise; when its turn comes, claims the mutex. The cron scheduler
 *   uses this so back-to-back ticks in the same space serialize rather
 *   than being dropped to contention.
 *
 * `withSpaceMutex` treats "queued waiter present" as busy so an HTTP
 * call can't race into the micro-window between two queued entries and
 * jump the line. That gives queued cron ticks a stable claim path: by
 * the time the previous queue entry's tail resolves, no fresh
 * `withSpaceMutex` caller can have taken `inFlight`.
 */

export class SpaceBusyError extends Error {
  /** Name of the role currently holding the mutex for this space. */
  inFlightRole: string;
  spaceName: string;

  constructor(spaceName: string, inFlightRole: string) {
    super(
      `space '${spaceName}' is busy running role '${inFlightRole}'`,
    );
    this.name = "SpaceBusyError";
    this.spaceName = spaceName;
    this.inFlightRole = inFlightRole;
  }
}

const inFlight = new Map<string, { role: string; startedAt: number }>();

interface QueueEntry {
  tail: Promise<void>;
  /** Role of the entry most recently appended to this space's queue.
   *  Used to give `withSpaceMutex`'s 409 a useful role name when the
   *  HTTP caller probes during the micro-window between two queued
   *  entries (inFlight momentarily empty, but the next entry is about
   *  to claim). */
  role: string;
}

const queueTails = new Map<string, QueueEntry>();

/** The role currently holding the mutex for `spaceName`, or null. */
export function inFlightRole(spaceName: string): string | null {
  return inFlight.get(spaceName)?.role ?? null;
}

/**
 * Run `fn` while holding the per-space mutex. Throws
 * `SpaceBusyError` synchronously (before invoking fn) if another
 * role is already running in the space, or if a queued waiter is
 * pending.
 */
export async function withSpaceMutex<T>(
  spaceName: string,
  role: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(spaceName);
  if (existing) {
    throw new SpaceBusyError(spaceName, existing.role);
  }
  const queued = queueTails.get(spaceName);
  if (queued) {
    throw new SpaceBusyError(spaceName, queued.role);
  }
  inFlight.set(spaceName, { role, startedAt: Date.now() });
  try {
    return await fn();
  } finally {
    inFlight.delete(spaceName);
  }
}

/**
 * Run `fn` after the per-space FIFO queue drains ahead of this call.
 * Used by the cron scheduler so back-to-back ticks in the same space
 * serialize rather than being dropped on contention.
 *
 * Ordering: each call appends to the space's queue tail before any
 * await, so the order of `queueSpaceMutex` invocations in a single
 * JS tick is the order they will run. Errors from `fn` propagate to
 * the caller but do not break the chain — the next queued entry
 * still runs.
 */
export async function queueSpaceMutex<T>(
  spaceName: string,
  role: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previousTail = queueTails.get(spaceName)?.tail ?? Promise.resolve();
  let resolveMyTail!: () => void;
  const myTail = new Promise<void>((r) => {
    resolveMyTail = r;
  });
  const myEntry: QueueEntry = { tail: myTail, role };
  queueTails.set(spaceName, myEntry);
  try {
    await previousTail;
    // Safe to claim: `withSpaceMutex` treats a queued waiter as busy,
    // so no HTTP caller can have taken `inFlight` while `myEntry` is
    // in `queueTails`. The previous queue entry released `inFlight`
    // in its inner finally before resolving its tail.
    inFlight.set(spaceName, { role, startedAt: Date.now() });
    try {
      return await fn();
    } finally {
      inFlight.delete(spaceName);
    }
  } finally {
    resolveMyTail();
    if (queueTails.get(spaceName) === myEntry) {
      queueTails.delete(spaceName);
    }
  }
}

/**
 * Test-only: drop all mutex state. Each test that exercises the
 * scheduler or the run route should call this in afterEach so leaked
 * state from one case doesn't bleed into the next.
 */
export function resetSpaceMutexForTests(): void {
  inFlight.clear();
  queueTails.clear();
}
