// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Universal mutation primitive for files inside a space.
 *
 * Every agent edit and CLI helper emits `FileEdit`s and runs them
 * through `applyEdit`. One chokepoint gives us one place to wire the
 * SQLite resync, edit-context registration, and edit_kinds audit.
 *
 * Four kinds:
 *   - create          new file. Fails if the path exists. Path-guarded
 *                     for wikis: paths under `wiki/` must end in `.html`.
 *   - insert_at_line  pure additive — insert content BEFORE the given
 *                     line. Existing content shifts down. Caller is
 *                     responsible for ensuring `line_number` is in
 *                     range (1..lines+1). Line numbers shift after this
 *                     edit; the agent runtime invalidates the read-gate
 *                     so the LLM re-reads before its next edit.
 *   - str_replace     SEARCH/REPLACE a unique span (Aider/Claude-Code
 *                     style). `search` must match exactly once.
 *   - delete          remove a file from disk and its entity from the
 *                     index. Used by `delete_wiki`; not in the writer's
 *                     surface.
 *
 * The five-mode legacy union (write/edit/annotate/delete_section) was
 * collapsed to these two-plus-create-plus-delete in Phase 1 per the
 * bake-off in tasks/v0-agent-harness-edit-primitives.md.
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
import { removeByPath, syncFile, type Space, type SyncResult } from "./sync.js";

export type FileEdit =
  | { kind: "create"; path: string; content: string }
  | {
      kind: "insert_at_line";
      path: string;
      line_number: number;
      content: string;
    }
  | { kind: "str_replace"; path: string; old_string: string; new_string: string }
  | { kind: "delete"; path: string };

export interface EditOpts {
  role: string;
  edit_kind: EditKind;
  note?: string;
}

/**
 * Resolve a relative path against a watch dir, rejecting absolute
 * paths and `..` escapes. Used wherever path strings cross a trust
 * boundary (LLM tool input, HTTP body, etc.).
 */
export function safeResolve(watchDir: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error(
      `path '${relativePath}' is absolute; must be relative to the watch dir`,
    );
  }
  if (relativePath.includes("\0")) {
    throw new Error(`path '${relativePath}' contains a NUL byte`);
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
  | {
      path: string;
      kind: "create" | "insert_at_line" | "str_replace";
      sync: SyncResult;
    }
  | { path: string; kind: "delete"; removed: boolean };

export async function applyEdit(
  space: Space,
  edit: FileEdit,
  opts: EditOpts,
): Promise<ApplyEditResult> {
  const absPath = safeResolve(space.watch_dir, edit.path);

  setEditContext(space.name, edit.path, {
    role: opts.role,
    edit_kind: opts.edit_kind,
    note: opts.note,
  });

  try {
    if (edit.kind === "create") {
      if (existsSync(absPath)) {
        throw new Error(
          `create_file: ${edit.path} already exists — use edit_file to modify it`,
        );
      }
      if (edit.path.startsWith("wiki/") && !edit.path.endsWith(".html")) {
        throw new Error(
          `create_file: wiki paths must end in .html (got '${edit.path}')`,
        );
      }
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, edit.content, "utf-8");
      const sync = await syncFile(space, edit.path);
      return { path: edit.path, kind: "create", sync };
    }

    if (edit.kind === "insert_at_line") {
      if (!existsSync(absPath)) {
        throw new Error(`edit_file: ${edit.path} does not exist`);
      }
      const original = readFileSync(absPath, "utf-8");
      const lines = original.split("\n");
      if (edit.line_number < 1 || edit.line_number > lines.length + 1) {
        throw new Error(
          `insert_at_line: line ${edit.line_number} out of range ` +
            `(file has ${lines.length} lines)`,
        );
      }
      const inserted = edit.content.split("\n");
      if (inserted[inserted.length - 1] === "") inserted.pop();
      lines.splice(edit.line_number - 1, 0, ...inserted);
      writeFileSync(absPath, lines.join("\n"), "utf-8");
      const sync = await syncFile(space, edit.path);
      return { path: edit.path, kind: "insert_at_line", sync };
    }

    if (edit.kind === "str_replace") {
      if (!existsSync(absPath)) {
        throw new Error(`edit_file: ${edit.path} does not exist`);
      }
      if (edit.old_string.length === 0) {
        throw new Error(`str_replace: old_string must be non-empty`);
      }
      const original = readFileSync(absPath, "utf-8");
      const matches = countOccurrences(original, edit.old_string);
      if (matches === 0) {
        throw new Error(
          `str_replace: old_string did not match in ${edit.path}. ` +
            `Tip: copy bytes verbatim from a recent read_file (no line-number prefixes).`,
        );
      }
      if (matches > 1) {
        throw new Error(
          `str_replace: old_string matched ${matches} times in ${edit.path} (must be unique). ` +
            `Expand the span until it is.`,
        );
      }
      const updated = original.replace(edit.old_string, edit.new_string);
      writeFileSync(absPath, updated, "utf-8");
      const sync = await syncFile(space, edit.path);
      return { path: edit.path, kind: "str_replace", sync };
    }

    // delete
    if (!existsSync(absPath)) {
      throw new Error(`delete_file: ${edit.path} does not exist`);
    }
    unlinkSync(absPath);
    const removed = await removeByPath(space, edit.path);
    return { path: edit.path, kind: "delete", removed };
  } finally {
    clearEditContext(space.name, edit.path);
  }
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

/**
 * Compose an HTML wiki shell from structured fields. Called by the
 * `create_file` tool. The agent provides `body` as the inner HTML
 * (typically starting with `<h1>`); the tool wraps it with `<head>`
 * containing `<title>` + `<meta>` so sync can extract metadata.
 *
 * Properties beyond `label`/`short_description` go in `extra`, which
 * gets emitted as additional `<meta name="..." content="...">` tags.
 */
export interface WikiShellFields {
  label: string;
  short_description: string;
  body: string;
  extra?: Record<string, string>;
}

export function composeWikiHtmlShell(fields: WikiShellFields): string {
  const metas = [
    `<meta name="label" content="${escapeAttr(fields.label)}">`,
    `<meta name="short_description" content="${escapeAttr(fields.short_description)}">`,
  ];
  for (const [name, content] of Object.entries(fields.extra ?? {})) {
    if (name === "label" || name === "short_description") continue;
    metas.push(`<meta name="${escapeAttr(name)}" content="${escapeAttr(content)}">`);
  }
  // <meta charset> declares the encoding so browsers don't default to
  // Latin-1 and mojibake smart quotes / em-dashes / non-ASCII. Per HTML5,
  // the charset meta must appear within the first 1024 bytes of the
  // document; putting it as the first child of <head> guarantees that.
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeAttr(fields.label)}</title>
${metas.join("\n")}
</head>
<body>
${fields.body}
</body>
</html>
`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
