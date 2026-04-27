// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Keyed in-process serialization. Wrap a critical section in
 * `withPathLock(key, fn)` and concurrent callers sharing the same key
 * run sequentially; different keys proceed in parallel.
 *
 * Used by `contribute()` (per-space) and the agent runtime
 * (per-role-and-target). In-process only — cross-process locking is
 * out of scope for the single-daemon model.
 */

const _keyQueues = new Map<string, Promise<unknown>>();

export function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = _keyQueues.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  _keyQueues.set(
    key,
    next.catch(() => {}),
  );
  return next;
}
