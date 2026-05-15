// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Walk every `<a href="...">` in an HTML wiki and resolve hrefs to
 * canonical `target_path` strings for the relationships table.
 *
 * Resolution rules:
 *   - External URLs (any scheme: `https://`, `mailto:`, `tel:`, …) → dropped.
 *   - Pure fragments (`#section`) → dropped (no edge to record).
 *   - Server-absolute paths (`/{space}/...`) → passed through as the
 *     canonical cross-space target. These are what the post-write
 *     rewriter emits when it can't resolve the named space against the
 *     local registry; preserving them keeps the relationship graph
 *     intact for unresolvable-yet-intentional cross-space pointers.
 *   - Relative paths → resolved against the article's directory,
 *     normalized, fragment/query stripped. The result is space-relative
 *     when it stays inside the watch_dir, or the `/{otherSpace}/{path}`
 *     canonical form when it lands inside a registered sibling space
 *     (requires `opts.spaces`).
 *   - Resolved paths that escape into NO registered space → dropped.
 *
 * Returned links carry `href` (original attribute), `text` (anchor body),
 * and `resolved` (the canonical `target_path`, or `null` if the link is
 * external/unresolvable and should not produce a row).
 */

import { parse } from "node-html-parser";
import { posix, resolve as fsResolve, sep as fsSep } from "node:path";

export interface HtmlLink {
  href: string;
  text: string;
  resolved: string | null;
}

export interface ResolveOpts {
  /** Name of the space the article lives in. */
  thisSpaceName: string;
  /** Absolute `watch_dir` for the article's space. */
  thisWatchDir: string;
  /** Every registered space, keyed by name → absolute `watch_dir`. */
  spaces: ReadonlyMap<string, string>;
}

export function extractHtmlLinks(
  html: string,
  fromPath: string,
  opts?: ResolveOpts,
): HtmlLink[] {
  const root = parse(html);
  const out: HtmlLink[] = [];
  for (const a of root.querySelectorAll("a")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    const text = a.text.trim();
    out.push({ href, text, resolved: resolveHref(href, fromPath, opts) });
  }
  return out;
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export function resolveHref(
  href: string,
  fromPath: string,
  opts?: ResolveOpts,
): string | null {
  if (SCHEME_RE.test(href)) return null;
  if (href.startsWith("#")) return null;
  if (href.startsWith("//")) return null;

  // Server-absolute path: canonical cross-space target (`/{space}/{path}`).
  // Pass through verbatim — these are already in the form `target_path`
  // expects. The post-write rewriter only emits this shape when the named
  // space isn't registered locally; preserving it lets cross-space pointers
  // round-trip through sync without being lost.
  if (href.startsWith("/")) {
    const clean = href.split(/[#?]/, 1)[0];
    if (!clean || clean === "/") return null;
    return clean;
  }

  const clean = href.split(/[#?]/, 1)[0];
  if (!clean) return null;

  // Hrefs are URL-encoded; entity source_paths are real filesystem strings.
  // Decode percent-escapes (`%20` → space, `%26` → `&`, ...) so the resolved
  // path is comparable to what's on disk. Without this, links to files whose
  // names contain spaces or other reserved chars render as red links.
  let decoded: string;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    decoded = clean;
  }

  const fromDir = posix.dirname(fromPath);
  const resolved = posix.normalize(posix.join(fromDir, decoded));

  if (resolved.startsWith("../") || resolved === ".." || resolved.startsWith("/")) {
    // The href escapes this space's watch_dir. If we have a spaces
    // map, check whether it actually lands inside another registered
    // space — if so, emit the canonical `/{otherSpace}/{path}` form
    // so the relationship graph carries the cross-space edge.
    if (opts) {
      const cross = detectCrossSpace(decoded, fromPath, opts);
      if (cross) return cross;
    }
    return null;
  }
  if (resolved === "." || resolved === "") return null;

  return resolved;
}

function detectCrossSpace(
  decodedRelativeHref: string,
  fromPath: string,
  opts: ResolveOpts,
): string | null {
  const articleAbsDir = fsResolve(opts.thisWatchDir, posix.dirname(fromPath));
  const absTarget = fsResolve(articleAbsDir, decodedRelativeHref);
  for (const [otherName, otherDir] of opts.spaces) {
    if (otherName === opts.thisSpaceName) continue;
    const normDir = fsResolve(otherDir);
    if (absTarget === normDir) continue; // bare watch_dir; no file path
    if (!absTarget.startsWith(normDir + fsSep)) continue;
    const within = absTarget
      .slice(normDir.length + 1)
      .split(fsSep)
      .join("/");
    if (!within) continue;
    return `/${otherName}/${within}`;
  }
  return null;
}
