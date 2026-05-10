// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * In-process registry of "an applyEdit() is currently writing this
 * file." Lets syncFile() distinguish a worker-driven edit (where
 * applyEdit registered a role + edit_kind before writing) from a
 * filesystem-driven edit (e.g. a human saving a wiki in their editor),
 * which has no registered context and is attributed to "human".
 *
 * Why a registry rather than threading parameters through syncFile:
 * the watcher independently calls syncFile on every file event, which
 * happens both when applyEdit just wrote the file AND when an external
 * editor did. The watcher has no knowledge of who wrote the file —
 * only the chokepoint that produced the write does. So the chokepoint
 * (applyEdit) deposits its context here before writing, and any
 * subsequent syncFile call for the same path during the lifetime of
 * that write reads the same context. The registry is cleared when
 * applyEdit returns, so further filesystem-driven syncs land as
 * "human".
 *
 * The registry is process-local. All daemon writes flow through this
 * process, so no cross-process coordination is needed.
 */

export type EditKind =
  | "create"
  | "append"
  | "replace"
  | "annotate"
  | "delete"
  | "delete_section"
  | "resync";

export interface EditContext {
  role: string;
  edit_kind: EditKind;
  note?: string;
}

const inflight = new Map<string, EditContext>();

function key(spaceId: string, relativePath: string): string {
  return `${spaceId}::${relativePath}`;
}

export function setEditContext(
  spaceId: string,
  relativePath: string,
  ctx: EditContext,
): void {
  inflight.set(key(spaceId, relativePath), ctx);
}

export function clearEditContext(spaceId: string, relativePath: string): void {
  inflight.delete(key(spaceId, relativePath));
}

/**
 * Read (without removing) the context for a path. Multiple syncFile
 * calls during a single applyEdit lifetime see the same value.
 */
export function getEditContext(
  spaceId: string,
  relativePath: string,
): EditContext | undefined {
  return inflight.get(key(spaceId, relativePath));
}

/** For tests: clear all in-flight entries. */
export function _clearAllEditContextsForTest(): void {
  inflight.clear();
}
