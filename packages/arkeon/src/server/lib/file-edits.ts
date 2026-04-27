// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Universal mutation primitive for wiki files.
 *
 * Every routing helper (contribute) and every agent emits `FileEdit`s
 * and runs them through `applyEdit`. One chokepoint gives us one place
 * to wire post-mutation indexing, future audit logging, and the rule
 * that the SQLite mirror is rebuilt from disk after every change.
 *
 * Three kinds:
 *   - write   create or overwrite a file with full content
 *   - edit    SEARCH/REPLACE a unique span in an existing file (Aider-style)
 *   - delete  remove a file from disk and the index
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { removeByPath, syncFile, type Space, type SyncResult } from "./sync.js";

export type FileEdit =
  | { kind: "write"; path: string; content: string }
  | { kind: "edit"; path: string; search: string; replace: string }
  | { kind: "delete"; path: string };

/**
 * Resolve a relative path against a watch dir, rejecting absolute paths
 * and `..` escapes. The returned path is guaranteed to be inside the
 * watch dir. Used wherever path strings cross a trust boundary (LLM
 * tool input, HTTP body, etc.).
 */
export function safeResolve(watchDir: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error(
      `path '${relativePath}' is absolute; must be relative to the watch dir`,
    );
  }
  const baseAbs = resolve(watchDir);
  const candidate = resolve(baseAbs, relativePath);
  if (candidate !== baseAbs && !candidate.startsWith(baseAbs + sep)) {
    throw new Error(
      `path '${relativePath}' escapes the space's watch directory`,
    );
  }
  return candidate;
}

export type ApplyEditResult =
  | { path: string; kind: "write" | "edit"; sync: SyncResult }
  | { path: string; kind: "delete"; removedEntityId: string | null };

/**
 * Apply a single edit and propagate the change into the SQLite index.
 *
 * Throws on edit semantics violations: missing files for `edit`/`delete`,
 * and SEARCH that doesn't match exactly once for `edit`.
 */
export async function applyEdit(space: Space, edit: FileEdit): Promise<ApplyEditResult> {
  const absPath = safeResolve(space.watch_dir, edit.path);

  if (edit.kind === "write") {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, edit.content, "utf-8");
    const sync = await syncFile(space, edit.path);
    return { path: edit.path, kind: "write", sync };
  }

  if (edit.kind === "edit") {
    if (!existsSync(absPath)) {
      throw new Error(`edit_file: ${edit.path} does not exist`);
    }
    if (edit.search.length === 0) {
      throw new Error(`edit_file: search must be non-empty`);
    }
    const original = readFileSync(absPath, "utf-8");
    const matches = countOccurrences(original, edit.search);
    if (matches === 0) {
      throw new Error(`edit_file: search did not match in ${edit.path}`);
    }
    if (matches > 1) {
      throw new Error(
        `edit_file: search matched ${matches} times in ${edit.path} (must be unique)`,
      );
    }
    const updated = original.replace(edit.search, edit.replace);
    writeFileSync(absPath, updated, "utf-8");
    const sync = await syncFile(space, edit.path);
    return { path: edit.path, kind: "edit", sync };
  }

  if (!existsSync(absPath)) {
    throw new Error(`delete_file: ${edit.path} does not exist`);
  }
  unlinkSync(absPath);
  const removedEntityId = await removeByPath(space.id, edit.path);
  return { path: edit.path, kind: "delete", removedEntityId };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}
