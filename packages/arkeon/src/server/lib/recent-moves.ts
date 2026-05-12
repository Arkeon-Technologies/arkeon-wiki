// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * In-process cache that pairs a watcher's `unlink` and `add` events
 * with matching content hashes into a "move detected" signal.
 *
 * Why this exists: relationships rows have no FK on `target_path`, so
 * a rename (`wiki/foo.html` → `wiki/foo-renamed.html`) leaves every
 * inbound edge pointing at the old path. Without move detection,
 * renames silently dump articles into the red-link queue until somebody
 * fixes the references by hand. The hash match lets us rewire the
 * inbound edges automatically.
 *
 * Mechanism: a single map keyed by `(space, hash)` collects whichever
 * event (delete or create) lands first. The opposite event, arriving
 * within the TTL, completes the pair and returns a `MoveCandidate`.
 *
 * False positives: two unrelated files with identical content hashes
 * within the TTL window would be mistaken for a rename. The cost is
 * one bad rewire of inbound edges (which the next watcher pass would
 * undo on the next real edit to either file). For v0 we accept the
 * rare false positive; tightening the match to also require same
 * basename is a v0.5 follow-up if it bites.
 */

const TTL_MS = 30_000;

interface PendingEntry {
  kind: "delete" | "create";
  path: string;
  at: number;
}

const pending = new Map<string, PendingEntry>();

function key(spaceName: string, hash: string): string {
  return `${spaceName}::${hash}`;
}

function gc(now: number): void {
  const cutoff = now - TTL_MS;
  for (const [k, v] of pending) {
    if (v.at < cutoff) pending.delete(k);
  }
}

export interface MoveCandidate {
  oldPath: string;
  newPath: string;
}

/**
 * Called from `removeByPath`. If a matching create was already cached
 * (i.e. the create event arrived first), returns the pair as a
 * MoveCandidate; otherwise stashes this delete for a future create
 * to find.
 */
export function recordDeleteOrMatch(
  spaceName: string,
  path: string,
  hash: string,
): MoveCandidate | null {
  const now = Date.now();
  gc(now);
  const k = key(spaceName, hash);
  const existing = pending.get(k);
  if (existing && existing.kind === "create" && existing.path !== path) {
    pending.delete(k);
    return { oldPath: path, newPath: existing.path };
  }
  pending.set(k, { kind: "delete", path, at: now });
  return null;
}

/**
 * Called from `syncFile` when a new entity is created. If a matching
 * delete was already cached (delete-then-create ordering), returns
 * the pair; otherwise stashes this create.
 */
export function recordCreateOrMatch(
  spaceName: string,
  path: string,
  hash: string,
): MoveCandidate | null {
  const now = Date.now();
  gc(now);
  const k = key(spaceName, hash);
  const existing = pending.get(k);
  if (existing && existing.kind === "delete" && existing.path !== path) {
    pending.delete(k);
    return { oldPath: existing.path, newPath: path };
  }
  pending.set(k, { kind: "create", path, at: now });
  return null;
}

/** For tests. */
export function _clearRecentMovesForTest(): void {
  pending.clear();
}
