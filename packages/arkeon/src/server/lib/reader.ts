// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure rendering primitives for the directory-browser reader.
 *
 *   - `rewriteWikilinks` — for served HTML, walk `<a class="wikilink">`
 *     anchors, resolve hrefs against the artifact index, and add
 *     `redlink` to the class list for unresolved targets.
 *   - `renderDirectoryListing` — `GET /<path>/` shows a directory's
 *     files and subdirs.
 *   - `renderNotFound` — 404 page.
 */

import { parse } from "node-html-parser";
import { posix } from "node:path";

import { resolveHref } from "./html-links.js";

export function rewriteWikilinks(
  html: string,
  fromPath: string,
  knownPaths: Set<string>,
): string {
  const root = parse(html);
  for (const a of root.querySelectorAll("a")) {
    const cls = a.getAttribute("class") ?? "";
    const tokens = new Set(cls.split(/\s+/).filter(Boolean));
    // Match the extraction rule in html-links.ts: only `class="wikilink"`
    // anchors participate in the link graph. Plain `<a href>` renders as
    // ordinary HTML — no redlink rewrite, no styling.
    if (!tokens.has("wikilink")) continue;
    const href = a.getAttribute("href");
    if (!href) continue;
    const resolved = resolveHref(href, fromPath);
    if (!resolved) continue;
    if (!knownPaths.has(resolved)) {
      tokens.add("redlink");
      a.setAttribute("class", [...tokens].join(" "));
    }
  }
  return root.toString();
}

export interface DirEntry {
  name: string;
  is_dir: boolean;
  /**
   * For files: artifact.label from the index (derived from
   * `<title>` or filename slug). Null for directories — they're
   * not in the artifact table.
   */
  label: string | null;
  /** For files: short_description from <meta name="short_description"> if any. */
  short_description: string | null;
}

export function renderDirectoryListing(dirPath: string, entries: DirEntry[]): string {
  const title = dirPath === "" ? "arkeon-wiki" : dirPath;
  const items = entries
    .map((e) => {
      const href = e.is_dir ? `${e.name}/` : e.name;
      // Anchor text: artifact label (typically the <title>) when it
      // adds information over the filename; otherwise the raw
      // filename. Sync falls back to the filename basename when
      // there's no <title>, so a label that matches basename(name)
      // or name itself is treated as "no real label" and skipped —
      // showing `paper (paper.md)` for a Markdown file would just
      // be noise. The filename is preserved alongside any real
      // label so the URL stays discoverable.
      let anchor: string;
      if (e.is_dir) {
        anchor = escapeHtml(e.name) + "/";
      } else if (e.label && !isFilenameDerivedLabel(e.label, e.name)) {
        anchor = `${escapeHtml(e.label)} <span class="ark-sub">(${escapeHtml(e.name)})</span>`;
      } else {
        anchor = escapeHtml(e.name);
      }
      const subtitle = e.short_description
        ? ` <span class="ark-sub">— ${escapeHtml(e.short_description)}</span>`
        : "";
      return `<li><a href="${escapeAttr(href)}">${anchor}</a>${subtitle}</li>`;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font: 14px system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; }
    .ark-sub { color: #666; }
    .ark-empty { color: #999; font-style: italic; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title || "/")}</h1>
  ${entries.length === 0 ? `<p class="ark-empty">(empty)</p>` : `<ul>${items}</ul>`}
</body>
</html>`;
}

export function renderNotFound(path: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Not found: ${escapeHtml(path)}</title>
</head>
<body>
  <h1>404 — not found</h1>
  <p><code>${escapeHtml(path)}</code></p>
</body>
</html>`;
}

/**
 * Returns true when `label` looks like sync's no-<title> fallback —
 * the filename with its extension stripped, or the filename itself.
 * Used to avoid emitting `Foo (foo.md)`-style noise for files whose
 * "label" is just the slug.
 */
function isFilenameDerivedLabel(label: string, name: string): boolean {
  if (label === name) return true;
  const dot = name.lastIndexOf(".");
  if (dot > 0 && label === name.slice(0, dot)) return true;
  return false;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// Re-exported for tests / future composition.
export { posix as path };
