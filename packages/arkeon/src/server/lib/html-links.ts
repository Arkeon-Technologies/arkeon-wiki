// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Walk every `<a class="wikilink">` in an HTML document and resolve
 * the href to a canonical `target_path` for the links table.
 *
 * Only anchors with the `wikilink` class produce link rows. Other
 * `<a>` elements render as ordinary HTML — the reader still rewrites
 * unresolved targets visually (via redlink class), but they aren't
 * part of the corpus graph.
 *
 * `<img src>` is intentionally NOT extracted — image refs aren't
 * citation-like edges; the directory-browser reader handles asset
 * resolution at serve time.
 *
 * Resolution rules:
 *   - External URLs (any scheme) → dropped.
 *   - Fragments (`#section`) → dropped.
 *   - Server-absolute paths (`/foo/bar`) → dropped (single watched
 *     root; treat absolute paths as out-of-scope).
 *   - Relative paths → resolved against the article's directory.
 *   - Resolved paths that escape the watched root → dropped.
 *
 * `data` carries every `data-*` attribute on the anchor with the
 * `data-` prefix stripped. Used for citation metadata
 * (data-quote, data-page, data-cite-type, …).
 */

import { parse } from "node-html-parser";
import { posix } from "node:path";

import { resolveByBasename } from "./basename-fallback.js";

export interface HtmlLink {
  href: string;
  text: string;
  resolved: string | null;
  data: Record<string, string>;
}

function hasWikilinkClass(cls: string | undefined): boolean {
  if (!cls) return false;
  return cls.split(/\s+/).some((token) => token === "wikilink");
}

/**
 * Extract every `<a class="wikilink">` from `html` and resolve its
 * href against the article's directory.
 *
 * When `knownPaths` is provided AND the literal-resolved path isn't
 * in it, fall back to a strict basename-unique match. This makes HTML
 * resolution symmetric with MD `[[X]]`: a target that moved between
 * folders heals automatically as long as its basename is unique.
 * Ambiguous basenames keep the literal path so the anchor still
 * surfaces as a redlink — same dedup rule MD uses.
 *
 * Callers that don't have an index handy (or want strict literal
 * resolution, e.g. for tests) can omit `knownPaths`; the resolver
 * then returns only the literal-relative path.
 */
export function extractHtmlLinks(
  html: string,
  fromPath: string,
  knownPaths?: ReadonlySet<string>,
): HtmlLink[] {
  const root = parse(html);
  const out: HtmlLink[] = [];
  for (const a of root.querySelectorAll("a")) {
    if (!hasWikilinkClass(a.getAttribute("class") ?? undefined)) continue;
    const href = a.getAttribute("href");
    if (!href) continue;
    const text = a.text.trim();
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(a.attributes)) {
      if (k.startsWith("data-")) data[k.slice(5)] = String(v);
    }
    const literal = resolveHref(href, fromPath);
    let resolved: string | null = literal;
    if (literal !== null && knownPaths !== undefined && !knownPaths.has(literal)) {
      const fallback = resolveByBasename(literal, knownPaths);
      if (fallback !== null) resolved = fallback;
    }
    out.push({ href, text, resolved, data });
  }
  return out;
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export function resolveHref(href: string, fromPath: string): string | null {
  if (SCHEME_RE.test(href)) return null;
  if (href.startsWith("#")) return null;
  if (href.startsWith("//")) return null;
  if (href.startsWith("/")) return null;

  const clean = href.split(/[#?]/, 1)[0];
  if (!clean) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    decoded = clean;
  }

  const fromDir = posix.dirname(fromPath);
  const resolved = posix.normalize(posix.join(fromDir, decoded));

  if (resolved.startsWith("../") || resolved === ".." || resolved.startsWith("/")) {
    return null;
  }
  if (resolved === "." || resolved === "") return null;

  return resolved;
}
