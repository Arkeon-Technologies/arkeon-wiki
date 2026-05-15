// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Translate space-rooted hrefs (`/{space-name}/{path}`) into the
 * correct on-disk relative path. Runs before `applyEdit` writes the
 * content to disk, so the disk form stays as ordinary relative paths
 * (preserves `file://` parity) but the agent gets to author links in
 * a depth-independent canonical form. The bake-off in issue #134
 * documents why agents fail at relative-path arithmetic and why this
 * sidesteps the failure mode entirely.
 *
 * Three classes of href:
 *
 *   - **In-space** (`/<this-space>/...`) — strip the prefix, compute
 *     a posix-relative path from the article's directory to the
 *     target. Always representable; output is what `<a href>` would
 *     traditionally hold.
 *   - **Cross-space** (`/<other-space>/...`) — look up the other
 *     space's `watch_dir`, compute a filesystem-relative path that
 *     crosses watch dirs. Brittle if the user later relocates either
 *     watch_dir, but recoverable (see the auto-fix-on-move follow-up
 *     in #134). When the other space isn't registered locally, the
 *     href is left as-is — broken on `file://` and 404 on `http://`,
 *     which is the correct UX for an unresolved cross-space link.
 *   - **Anything else** (relative paths, fragments, external URLs)
 *     — passed through verbatim. Agents that prefer to write
 *     correct relative paths directly keep working.
 *
 * Walks `<a href>`, `<img src>`, and `<link href>`. The same rewriter
 * runs over full HTML documents (`create_file`) and over snippets
 * (`insert_at_line` content, `str_replace` new_string) — `node-html-parser`
 * handles both shapes.
 *
 * For `str_replace`: rewrite **only** the new_string. `old_string`
 * must match disk bytes verbatim, which by definition are the
 * already-rewritten relative form.
 */

import { parse as parseHtml } from "node-html-parser";
import { posix } from "node:path";
import { relative as fsRelative, resolve as fsResolve, sep as fsSep } from "node:path";

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

const REWRITE_TARGETS: ReadonlyArray<{ tag: string; attr: string }> = [
  { tag: "a", attr: "href" },
  { tag: "img", attr: "src" },
  { tag: "link", attr: "href" },
];

export interface RewriteOpts {
  /**
   * Path of the article being edited, relative to its space's
   * watch_dir (e.g. `wiki/foo.html`, `wiki/_plans/sources/x.html`).
   * The rewriter computes relative paths *from this file's directory*.
   */
  fromPath: string;
  /** The space the article belongs to. First-segment matches strip-and-relativize. */
  spaceName: string;
  /**
   * Every registered space, keyed by name → absolute `watch_dir`.
   * Must include the current space.
   */
  spaces: ReadonlyMap<string, string>;
}

/**
 * Rewrite space-rooted hrefs in a string of HTML (full document or
 * fragment) and return the serialized result.
 *
 * Idempotent: a rewritten output passed back through is left alone
 * because in-space hrefs are no longer `/`-prefixed.
 */
export function rewriteHrefsForWrite(html: string, opts: RewriteOpts): string {
  const root = parseHtml(html);
  let mutated = false;
  for (const { tag, attr } of REWRITE_TARGETS) {
    for (const el of root.querySelectorAll(tag)) {
      const value = el.getAttribute(attr);
      if (value == null) continue;
      const rewritten = maybeRewriteHref(value, opts);
      if (rewritten !== null && rewritten !== value) {
        el.setAttribute(attr, rewritten);
        mutated = true;
      }
    }
  }
  // Hand back the original bytes when nothing changed — `node-html-parser`'s
  // round-trip normalizes whitespace and self-closing tags, which we'd
  // rather not impose on snippets that didn't need any rewriting.
  return mutated ? root.toString() : html;
}

/**
 * Decide whether an individual href needs rewriting and return its
 * new value. Returns `null` when the href is in a class we don't
 * touch (relative, external, fragment, unresolvable cross-space),
 * which the caller treats as "leave verbatim."
 */
export function maybeRewriteHref(
  href: string,
  opts: RewriteOpts,
): string | null {
  if (SCHEME_RE.test(href)) return null;
  if (href.startsWith("#")) return null;
  if (href.startsWith("//")) return null;
  if (!href.startsWith("/")) return null;

  // Preserve `#fragment` / `?query` suffixes so anchors and viewer
  // hints round-trip cleanly.
  const splitAt = href.search(/[#?]/);
  const pathPart = splitAt === -1 ? href : href.slice(0, splitAt);
  const suffix = splitAt === -1 ? "" : href.slice(splitAt);

  const rawSegments = pathPart.slice(1).split("/");
  if (rawSegments.length === 0 || rawSegments[0] === "") return null;

  let decodedSegments: string[];
  try {
    decodedSegments = rawSegments.map((s) => decodeURIComponent(s));
  } catch {
    // Malformed percent encoding — leave the agent's bytes alone.
    return null;
  }

  const firstSegment = decodedSegments[0];
  const inSpaceParts = decodedSegments.slice(1);
  const inSpacePath = inSpaceParts.join("/");

  if (firstSegment === opts.spaceName) {
    const rel = computeInSpaceRelative(opts.fromPath, inSpacePath);
    if (rel === null) return null;
    return encodeRelPath(rel) + suffix;
  }

  const otherWatchDir = opts.spaces.get(firstSegment);
  const thisWatchDir = opts.spaces.get(opts.spaceName);
  if (otherWatchDir && thisWatchDir) {
    const rel = computeCrossSpaceRelative(
      thisWatchDir,
      opts.fromPath,
      otherWatchDir,
      inSpacePath,
    );
    if (rel === null) return null;
    return encodeRelPath(rel) + suffix;
  }

  // First segment matches no registered space. Leave the agent's
  // bytes alone — a deliberate unresolvable cross-space pointer
  // should show up as a red link / 404 rather than be silently
  // mutated into something else.
  return null;
}

function computeInSpaceRelative(
  fromPath: string,
  targetInSpace: string,
): string | null {
  // Normalize first so any `..` segments collapse. If the result
  // still escapes the space root, refuse the rewrite — we don't
  // emit relative paths that step outside the watch_dir, even when
  // the agent literally asks for them (`/{thisSpace}/../../etc/passwd`
  // would otherwise produce a working filesystem-relative link).
  const normalized = posix.normalize(targetInSpace);
  if (
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized.startsWith("/")
  ) {
    return null;
  }
  const fromDir = posix.dirname(fromPath);
  const rel = posix.relative(fromDir, normalized);
  return rel === "" ? "." : rel;
}

function computeCrossSpaceRelative(
  thisWatchDir: string,
  fromPath: string,
  otherWatchDir: string,
  targetInOtherSpace: string,
): string | null {
  // Watch dirs are absolute filesystem paths; use the OS-native
  // `path` module (not posix) so Windows separators behave
  // correctly. Output is normalized back to posix below.
  const normDir = fsResolve(otherWatchDir);
  const targetAbs = fsResolve(otherWatchDir, targetInOtherSpace);
  // Refuse if the resolved target falls outside the destination
  // space's watch_dir. Without this guard, `/other/../../etc/passwd`
  // resolves to `/etc/passwd` and the rewriter happily produces a
  // valid filesystem-relative href escaping every space root.
  if (targetAbs !== normDir && !targetAbs.startsWith(normDir + fsSep)) {
    return null;
  }
  const articleAbsDir = fsResolve(thisWatchDir, posix.dirname(fromPath));
  const rel = fsRelative(articleAbsDir, targetAbs);
  const normalized = rel.split(/[\\/]/g).join("/");
  return normalized === "" ? "." : normalized;
}

/**
 * URL-encode each path segment. Matches the existing convention in
 * `renderArticleIndex` and keeps `resolveHref`'s `decodeURIComponent`
 * round-trip clean for filenames with spaces, ampersands, etc.
 */
function encodeRelPath(p: string): string {
  return p
    .split("/")
    .map((seg) => (seg === ".." || seg === "." ? seg : encodeURIComponent(seg)))
    .join("/");
}
