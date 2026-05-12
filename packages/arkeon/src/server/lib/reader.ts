// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure rendering primitives for the Phase 2 reader.
 *
 * The four routes are thin glue over four functions in this file:
 *
 *   - `classifyAnchor`        decide which classes an `<a href>` earns.
 *   - `instrumentArticle`     parse a wiki article, tag links, inject chrome.
 *   - `renderSpaceIndex`      `GET /` — list of spaces on this daemon.
 *   - `renderArticleIndex`    `GET /{space}/` — alphabetical article list.
 *
 * All four are deterministic and DB-free — the route handlers pass in the
 * data they need (space rows, entity rows, the set of known paths in the
 * article's space). Easy to unit-test.
 *
 * The injected chrome is a single `<div id="arkeon-chrome">` after `<body>`
 * open, plus a small `<style>` block in `<head>`. CSS is scoped to
 * `#arkeon-chrome` and to the three link classes the server adds:
 *
 *   - `arkeon-wiki`     target ends in `.html` (lives under any directory)
 *   - `arkeon-file`     anything else (markdown, pdf, image, …)
 *   - `arkeon-redlink`  target has no `entities` row for this space
 *
 * The classes are independent and combine freely. Article-author `<style>`
 * blocks can override via specificity.
 */

import { parse } from "node-html-parser";
import { posix } from "node:path";

import { resolveHref } from "./html-links.js";

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Decide which `arkeon-*` classes to add to a single anchor.
 *
 * Returns an empty array when the href is external, a fragment, a
 * server-absolute path (`/...` — reserved for cross-space in v0.5), or
 * escapes the space root. Those anchors render with no extra classes
 * and behave like normal links.
 *
 * Otherwise the result is some combination of `arkeon-wiki` /
 * `arkeon-file` plus an optional `arkeon-redlink`.
 */
export function classifyAnchor(
  href: string,
  fromPath: string,
  knownPaths: Set<string>,
): string[] {
  if (!href) return [];
  if (href.startsWith("#")) return [];
  if (SCHEME_RE.test(href)) return [];
  if (href.startsWith("//")) return [];
  if (href.startsWith("/")) return []; // reserved for cross-space

  const resolved = resolveHref(href, fromPath);
  if (!resolved) return [];

  const classes: string[] = [];
  classes.push(resolved.toLowerCase().endsWith(".html") ? "arkeon-wiki" : "arkeon-file");
  if (!knownPaths.has(resolved)) classes.push("arkeon-redlink");
  return classes;
}

const CHROME_CSS = `
#arkeon-chrome {
  position: sticky;
  top: 0;
  z-index: 9999;
  padding: 8px 16px;
  background: #f5f5f5;
  border-bottom: 1px solid #e0e0e0;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 14px;
  color: #333;
}
#arkeon-chrome a.arkeon-back { color: #555; text-decoration: none; }
#arkeon-chrome a.arkeon-back:hover { color: #000; }
a.arkeon-file { color: #4a6b7c; text-decoration: underline dotted; text-underline-offset: 2px; }
a.arkeon-file:hover { color: #2c4a59; text-decoration: underline; }
a.arkeon-redlink { color: #c00; }
a.arkeon-redlink:hover { color: #900; text-decoration: underline; }
`.trim();

/**
 * Parse an article's HTML, decorate every relative `<a>` with the
 * appropriate `arkeon-*` classes, inject the chrome div + style, and
 * return the serialized document.
 *
 * Idempotent enough for v0: if the page already has an `#arkeon-chrome`
 * element we skip re-injecting (defensive against double-renders, not a
 * real concern since articles on disk never contain one).
 */
export function instrumentArticle(
  html: string,
  fromPath: string,
  knownPaths: Set<string>,
  spaceName: string,
): string {
  const root = parse(html);

  for (const a of root.querySelectorAll("a")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    const added = classifyAnchor(href, fromPath, knownPaths);
    if (added.length === 0) continue;
    const existing = (a.getAttribute("class") ?? "").trim();
    const merged = existing ? `${existing} ${added.join(" ")}` : added.join(" ");
    a.setAttribute("class", merged);
  }

  const head = root.querySelector("head");
  if (head && !head.querySelector("style[data-arkeon-chrome]")) {
    head.insertAdjacentHTML(
      "beforeend",
      `<style data-arkeon-chrome>${CHROME_CSS}</style>`,
    );
  }

  const body = root.querySelector("body");
  if (body && !body.querySelector("#arkeon-chrome")) {
    const safeName = escapeHtml(spaceName);
    body.insertAdjacentHTML(
      "afterbegin",
      `<div id="arkeon-chrome"><a class="arkeon-back" href="/${encodeURIComponent(spaceName)}/">&larr; ${safeName}</a></div>`,
    );
  }

  return root.toString();
}

export interface SpaceIndexRow {
  name: string;
  entity_count: number;
}

/**
 * Render the daemon-level landing page. Always shows the full list of
 * spaces, even when there's only one — no redirect, no "featured"
 * selection. Simple and predictable.
 */
export function renderSpaceIndex(spaces: SpaceIndexRow[]): string {
  const rows = spaces
    .map(
      (s) =>
        `    <li><a href="/${encodeURIComponent(s.name)}/">${escapeHtml(s.name)}</a> — ${s.entity_count} ${s.entity_count === 1 ? "entity" : "entities"}</li>`,
    )
    .join("\n");
  const empty = `    <li><em>no spaces registered yet — run <code>arkeon-wiki init</code> in a directory to create one</em></li>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>arkeon-wiki</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #222; }
    h1 { font-size: 1.4rem; margin-bottom: 1rem; }
    ul { list-style: none; padding: 0; }
    li { padding: 0.4rem 0; border-bottom: 1px solid #eee; }
    a { color: #0366d6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { background: #f4f4f4; padding: 0 0.3em; border-radius: 3px; font-size: 0.95em; }
  </style>
</head>
<body>
  <h1>arkeon-wiki</h1>
  <ul>
${spaces.length === 0 ? empty : rows}
  </ul>
</body>
</html>
`;
}

export interface ArticleIndexRow {
  source_path: string;
  label: string | null;
  short_description: string | null;
}

/**
 * Render the per-space alphabetical article index. Each row links to
 * the wiki article via its on-disk path under `/{space}/wiki/...`.
 *
 * `label` falls back to the bare filename if missing (the writer is
 * supposed to emit `<title>`, so this is just defensive).
 */
export function renderArticleIndex(
  spaceName: string,
  articles: ArticleIndexRow[],
): string {
  const sorted = [...articles].sort((a, b) => {
    const al = (a.label ?? posix.basename(a.source_path)).toLowerCase();
    const bl = (b.label ?? posix.basename(b.source_path)).toLowerCase();
    if (al < bl) return -1;
    if (al > bl) return 1;
    return 0;
  });

  const rows = sorted
    .map((a) => {
      const display = escapeHtml(a.label ?? posix.basename(a.source_path));
      const href = `/${encodeURIComponent(spaceName)}/${a.source_path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
      const sub = a.short_description
        ? `<p class="desc">${escapeHtml(a.short_description)}</p>`
        : "";
      return `    <li><a href="${href}">${display}</a>${sub}</li>`;
    })
    .join("\n");

  const empty = `    <li><em>no articles yet — the writer creates them on its cron schedule.</em></li>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(spaceName)} — arkeon-wiki</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #222; }
    h1 { font-size: 1.4rem; margin-bottom: 1rem; }
    .crumb { color: #888; font-size: 0.9em; margin-bottom: 1rem; }
    .crumb a { color: #888; }
    ul { list-style: none; padding: 0; }
    li { padding: 0.6rem 0; border-bottom: 1px solid #eee; }
    a { color: #0366d6; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .desc { color: #555; margin: 0.2rem 0 0 0; font-size: 0.95em; }
  </style>
</head>
<body>
  <p class="crumb"><a href="/">&larr; spaces</a></p>
  <h1>${escapeHtml(spaceName)}</h1>
  <ul>
${sorted.length === 0 ? empty : rows}
  </ul>
</body>
</html>
`;
}

/**
 * Render a minimal 404 page for the reader. The article/file route
 * uses this when a path doesn't resolve. Red text on a missing wiki
 * link is enough signal in the article view; this page is just for the
 * direct-navigation case.
 */
export function renderNotFound(spaceName: string, path: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>not found — ${escapeHtml(spaceName)}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 720px; margin: 4rem auto; padding: 0 1rem; color: #222; }
    h1 { color: #c00; font-size: 1.4rem; }
    code { background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px; }
    p { color: #555; }
    a { color: #0366d6; }
  </style>
</head>
<body>
  <h1>not found</h1>
  <p><code>${escapeHtml(path)}</code> doesn't exist in space <code>${escapeHtml(spaceName)}</code>.</p>
  <p><a href="/${encodeURIComponent(spaceName)}/">&larr; back to ${escapeHtml(spaceName)}</a></p>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
