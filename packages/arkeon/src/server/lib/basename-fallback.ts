// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Basename-fallback resolution for path-form wikilink targets.
 *
 * Problem this solves: HTML `<a class="wikilink" href="./X">` resolves
 * via relative-path math. If `X` moves between folders, the inbound
 * href no longer resolves and shows as a redlink — even though the
 * target still exists at a different location. MD `[[X]]` already
 * handles this via shortest-unique-basename matching; this helper
 * brings the same convergence to HTML hrefs whose literal-resolved
 * path is broken.
 *
 * Strict basename match (file extension included). `./article.html`
 * falls back only to another `article.html` somewhere in the tree,
 * not to `article.md` — the operator was specific about the
 * extension; respect that.
 *
 * Ambiguous basename (multiple matches) returns null so the caller
 * keeps the literal-resolved path and the anchor surfaces as a
 * redlink. Same dedup contract as MD `[[X]]` against multiple
 * basename matches.
 */

import { posix } from "node:path";

/**
 * Look for a known artifact whose basename matches `literalResolved`'s
 * basename. Returns the unique match's path if exactly one exists and
 * it differs from the literal target; otherwise null.
 *
 * Callers should fall back to `literalResolved` (which surfaces as a
 * redlink) when this returns null.
 */
export function resolveByBasename(
  literalResolved: string,
  knownPaths: ReadonlySet<string>,
): string | null {
  if (knownPaths.has(literalResolved)) return null;
  const targetBase = posix.basename(literalResolved).toLowerCase();
  if (!targetBase) return null;
  let match: string | null = null;
  for (const p of knownPaths) {
    if (posix.basename(p).toLowerCase() !== targetBase) continue;
    if (match !== null) return null; // ambiguous → no fallback
    match = p;
  }
  return match;
}

/**
 * Build a relative href from `fromPath`'s directory to `targetPath`.
 * Used by the reader when rewriting a broken href to the basename-
 * fallback resolved target so the rendered HTML navigates correctly
 * (the source file on disk is left untouched).
 */
export function relativeHref(fromPath: string, targetPath: string): string {
  const fromDir = posix.dirname(fromPath);
  // posix.dirname("foo.html") returns ".", which posix.relative
  // treats as the current directory — exactly what we want for a
  // root-level source. Pass "" through the same branch as "." so
  // both behave identically.
  const base = fromDir === "." || fromDir === "" ? "" : fromDir;
  return base === "" ? targetPath : posix.relative(base, targetPath);
}
