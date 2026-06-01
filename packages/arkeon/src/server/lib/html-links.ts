// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Walk every `<a href>` and `<img src>` in an HTML document and resolve
 * URLs to canonical `target_path` strings for the links table.
 *
 * Resolution rules:
 *   - External URLs (any scheme) → dropped.
 *   - Fragments (`#section`) → dropped.
 *   - Server-absolute paths (`/foo/bar`) → dropped (v1 has one watched
 *     root; treat absolute paths as out-of-scope).
 *   - Relative paths → resolved against the article's directory.
 *   - Resolved paths that escape the watched root → dropped.
 *
 * `data` carries every `data-*` attribute on the anchor with the
 * `data-` prefix stripped. Used for citation metadata
 * (data-quote, data-page, data-cite-type, …).
 *
 * Phase 6 will narrow the `<a>` extraction to elements with
 * class="wikilink" only.
 */

import { parse } from "node-html-parser";
import { posix } from "node:path";

export interface HtmlLink {
  href: string;
  text: string;
  resolved: string | null;
  data: Record<string, string>;
}

export function extractHtmlLinks(html: string, fromPath: string): HtmlLink[] {
  const root = parse(html);
  const out: HtmlLink[] = [];
  for (const a of root.querySelectorAll("a")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    const text = a.text.trim();
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(a.attributes)) {
      if (k.startsWith("data-")) data[k.slice(5)] = String(v);
    }
    out.push({ href, text, resolved: resolveHref(href, fromPath), data });
  }
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (!src) continue;
    const text = (img.getAttribute("alt") ?? "").trim();
    out.push({ href: src, text, resolved: resolveHref(src, fromPath), data: {} });
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
