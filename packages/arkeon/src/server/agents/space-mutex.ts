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
 * Behavior is non-blocking: `withSpaceMutex` throws `SpaceBusyError`
 * if another role is already running in the space. The cron scheduler
 * uses this to log skip-and-reschedule; the HTTP route uses it to
 * return 409. Neither caller queues — queueing is intentionally not
 * a primitive here.
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

/** The role currently holding the mutex for `spaceName`, or null. */
export function inFlightRole(spaceName: string): string | null {
  return inFlight.get(spaceName)?.role ?? null;
}

/**
 * Run `fn` while holding the per-space mutex. Throws
 * `SpaceBusyError` synchronously (before invoking fn) if another
 * role is already running in the space.
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
  inFlight.set(spaceName, { role, startedAt: Date.now() });
  try {
    return await fn();
  } finally {
    inFlight.delete(spaceName);
  }
}

/**
 * Test-only: drop all mutex state. Each test that exercises the
 * scheduler or the run route should call this in afterEach so leaked
 * state from one case doesn't bleed into the next.
 */
export function resetSpaceMutexForTests(): void {
  inFlight.clear();
}
