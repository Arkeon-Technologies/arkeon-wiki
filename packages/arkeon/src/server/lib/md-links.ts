// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Markdown wikilink extraction: `[[X]]` and `[[X|alias]]`.
 *
 * Resolution:
 *   - `[[X]]` resolves against the artifact index via shortest-unique-path
 *     match. `X` may include a folder prefix (`[[iarpa/X]]`) for
 *     disambiguation.
 *   - `[[X|Display Name]]` carries an alias as link_text; the target
 *     resolution uses `X`.
 *   - Unresolved targets stay as the literal target string — they show
 *     up as redlinks via the LEFT JOIN at query time, same as HTML
 *     wikilinks.
 *
 * Mirrors the HtmlLink shape so syncFile can persist either uniformly.
 * `data` is always empty for MD links (no inline data-* attributes;
 * citation metadata in MD would need a different convention to land).
 */

import { posix } from "node:path";

import type { HtmlLink } from "./html-links.js";

const WIKILINK_RE = /\[\[([^\]\|]+)(?:\|([^\]]+))?\]\]/g;

export function extractMarkdownLinks(
  content: string,
  fromPath: string,
  knownPaths?: ReadonlySet<string>,
): HtmlLink[] {
  const out: HtmlLink[] = [];
  for (const match of content.matchAll(WIKILINK_RE)) {
    const raw = match[1].trim();
    const alias = match[2]?.trim();
    if (!raw) continue;
    const resolved = resolveWikilink(raw, fromPath, knownPaths);
    out.push({
      href: raw,
      text: alias ?? raw,
      resolved,
      data: {},
    });
  }
  return out;
}

/**
 * Resolve a markdown wikilink target against the index.
 *
 * Strategy:
 *   1. If `target` contains "/", treat it as a relative path against
 *      the file's directory. Useful for explicit disambiguation
 *      (`[[iarpa/sources/foo.md]]`) and for paths that already include
 *      an extension.
 *   2. Otherwise: search `knownPaths` for a path whose basename
 *      (with or without extension) matches `target` case-insensitively.
 *      If exactly one matches, use it. If multiple match, return the
 *      target verbatim (becomes a redlink — the user can disambiguate
 *      with a folder prefix).
 *   3. Fallback: return the target as-is so it shows up as a redlink.
 */
export function resolveWikilink(
  target: string,
  fromPath: string,
  knownPaths?: ReadonlySet<string>,
): string {
  if (target.includes("/")) {
    const fromDir = posix.dirname(fromPath);
    const candidate = target.startsWith("./") || target.startsWith("../")
      ? posix.normalize(posix.join(fromDir, target))
      : posix.normalize(target);
    if (
      candidate.startsWith("../") ||
      candidate === ".." ||
      candidate.startsWith("/") ||
      candidate === "." ||
      candidate === ""
    ) {
      return target;
    }
    return candidate;
  }

  if (knownPaths) {
    const normalized = target.toLowerCase();
    const matches: string[] = [];
    for (const p of knownPaths) {
      const base = posix.basename(p).toLowerCase();
      const stem = base.replace(/\.[^.]+$/, "");
      if (base === normalized || stem === normalized) {
        matches.push(p);
      }
    }
    if (matches.length === 1) return matches[0];
  }

  return target;
}
