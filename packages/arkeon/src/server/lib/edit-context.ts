// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * In-process registry of "an applyEdit() is currently writing this
 * file." Lets syncFile() distinguish a worker-driven edit (where
 * applyEdit registered a role + edit_kind before writing) from a
 * filesystem-driven edit (e.g. a human saving a wiki in their editor),
 * which has no registered context and is attributed to "human".
 *
 * Orthogonal to the agent runtime's read-gate, which lives on
 * `AgentContext.readPaths` and gates tool-call discipline. This
 * registry is purely about attribution on the resulting `entity_edits`
 * row.
 *
 * The registry is process-local. All daemon writes flow through this
 * process, so no cross-process coordination is needed.
 */

export type EditKind =
  | "create"
  | "insert_at_line"
  | "str_replace"
  | "delete"
  | "resync";

export interface EditContext {
  role: string;
  edit_kind: EditKind;
  note?: string;
}

const inflight = new Map<string, EditContext>();

function key(spaceName: string, relativePath: string): string {
  return `${spaceName}::${relativePath}`;
}

export function setEditContext(
  spaceName: string,
  relativePath: string,
  ctx: EditContext,
): void {
  inflight.set(key(spaceName, relativePath), ctx);
}

export function clearEditContext(spaceName: string, relativePath: string): void {
  inflight.delete(key(spaceName, relativePath));
}

/**
 * Read (without removing) the context for a path. Multiple syncFile
 * calls during a single applyEdit lifetime see the same value.
 */
export function getEditContext(
  spaceName: string,
  relativePath: string,
): EditContext | undefined {
  return inflight.get(key(spaceName, relativePath));
}

/** For tests: clear all in-flight entries. */
export function _clearAllEditContextsForTest(): void {
  inflight.clear();
}
