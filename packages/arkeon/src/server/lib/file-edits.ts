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

import {
  clearEditContext,
  setEditContext,
  type EditKind,
} from "./edit-context.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { removeByPath, syncFile, type Space, type SyncResult } from "./sync.js";

export type FileEdit =
  | { kind: "write"; path: string; content: string }
  | { kind: "edit"; path: string; search: string; replace: string }
  | { kind: "delete"; path: string };

/**
 * Caller-supplied attribution for a single applyEdit() call. The role
 * is stamped into the file's frontmatter (for .md targets) so a human
 * reading the file sees who last touched it, and is also threaded
 * into the edit-context registry so syncFile() inserts the right
 * `by_role` into entity_edits when it observes the resulting write.
 *
 * `edit_kind` is the semantic kind of edit (more granular than the
 * FileEdit kind — e.g. a `kind: "write"` FileEdit can be a CREATE or
 * an APPEND depending on whether the target already existed).
 *
 * `note` is an optional one-line summary surfaced by /entities/{id}/history.
 */
export interface EditOpts {
  role: string;
  edit_kind: EditKind;
  note?: string;
}

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
 * For write/edit kinds on .md files, the file's YAML frontmatter is
 * stamped with `edited_by: <role>` (and `edit_note` if supplied) so a
 * human reader of the file can see who last touched it. The same
 * attribution is registered in the edit-context registry for the
 * lifetime of the call so syncFile() can record an entity_edits row
 * with the correct `by_role`.
 *
 * Throws on edit semantics violations: missing files for `edit`/`delete`,
 * and SEARCH that doesn't match exactly once for `edit`.
 */
export async function applyEdit(
  space: Space,
  edit: FileEdit,
  opts: EditOpts,
): Promise<ApplyEditResult> {
  const absPath = safeResolve(space.watch_dir, edit.path);
  const isMarkdown = edit.path.endsWith(".md");

  setEditContext(space.id, edit.path, {
    role: opts.role,
    edit_kind: opts.edit_kind,
    note: opts.note,
  });

  try {
    if (edit.kind === "write") {
      const stamped = isMarkdown
        ? stampFrontmatter(edit.content, opts.role, opts.note)
        : edit.content;
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, stamped, "utf-8");
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
      let updated = original.replace(edit.search, edit.replace);
      if (isMarkdown) {
        updated = stampFrontmatter(updated, opts.role, opts.note);
      }
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
  } finally {
    clearEditContext(space.id, edit.path);
  }
}

/**
 * Stamp `edited_by` (and optionally `edit_note`) into the file's YAML
 * frontmatter. No-op when the input content doesn't already have a
 * frontmatter block — we only annotate files whose authors opted in
 * to YAML metadata, never invent it. Wiki bodies always start with
 * `---\n`, so stamping applies to wiki CREATE / APPEND / REPLACE.
 * A future tool that writes a non-wiki .md (e.g. README.md without
 * frontmatter) gets no surprise stamp.
 *
 * If `edit_note` is empty/missing, any prior note is removed so an
 * old note doesn't linger past the next edit.
 */
function stampFrontmatter(content: string, role: string, note?: string): string {
  if (!content.trimStart().startsWith("---")) return content;
  const { properties, body } = parseFrontmatter(content);
  properties.edited_by = role;
  if (note != null && note.trim().length > 0) {
    properties.edit_note = note;
  } else {
    delete properties.edit_note;
  }
  return serializeFrontmatter(properties, body);
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
