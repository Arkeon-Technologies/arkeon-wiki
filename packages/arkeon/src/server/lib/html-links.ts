// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Walk every `<a href="...">` in an HTML wiki and resolve hrefs to
 * space-relative paths. Replaces the old markdown-links + wikilink
 * pipeline.
 *
 * Resolution rules:
 *   - External URLs (anything with a scheme: `https://`, `mailto:`,
 *     `tel:`, etc.) → dropped.
 *   - Pure fragments (`#section`) → dropped (no edge to record).
 *   - Server-absolute paths starting with `/` → dropped in v0.
 *     The committed URL scheme reserves `/{other-space}/...` for
 *     cross-space links (v0.5); v0 doesn't emit or follow them.
 *   - Relative paths → resolved against the article's directory,
 *     normalized, fragment/query stripped.
 *   - Resolved paths that escape the space root (`../../foo`) → dropped.
 *
 * Returned links carry `href` (original attribute), `text` (anchor body),
 * and `resolved` (the space-relative path the relationship row points
 * at, or `null` if the link is external/unresolvable and should not
 * produce a row).
 */

import { parse } from "node-html-parser";
import { posix } from "node:path";

export interface HtmlLink {
  href: string;
  text: string;
  resolved: string | null;
}

export function extractHtmlLinks(html: string, fromPath: string): HtmlLink[] {
  const root = parse(html);
  const out: HtmlLink[] = [];
  for (const a of root.querySelectorAll("a")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    const text = a.text.trim();
    out.push({ href, text, resolved: resolveHref(href, fromPath) });
  }
  return out;
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export function resolveHref(href: string, fromPath: string): string | null {
  if (SCHEME_RE.test(href)) return null;
  if (href.startsWith("#")) return null;
  if (href.startsWith("//")) return null;
  if (href.startsWith("/")) return null; // cross-space reserved for v0.5

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
    return null;
  }
  if (resolved === "." || resolved === "") return null;

  return resolved;
}
