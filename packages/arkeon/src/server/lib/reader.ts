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
import { posix, resolve as fsResolve, sep as fsSep } from "node:path";

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

export interface CrossSpaceTarget {
  /** The other space's name. */
  space: string;
  /** The path within that space's watch_dir. */
  path: string;
  /** Any `#fragment` or `?query` suffix on the original href. */
  suffix: string;
}

/**
 * Detect whether a relative href on disk actually resolves into
 * another registered space's watch_dir. Returns the cross-space
 * target if so — the reader uses this to rewrite the rendered `href`
 * back to `/{otherSpace}/{path}` for http:// click-through, since
 * `../../work/other/wiki/foo.html` would otherwise resolve to a URL
 * the daemon doesn't serve.
 *
 * Returns null for in-space relative hrefs, externals, fragments,
 * server-absolute paths, and unresolvable escapes (`../../etc/passwd`
 * style — they're not under any registered space).
 */
export function crossSpaceTarget(
  href: string,
  fromPath: string,
  thisSpaceName: string,
  thisWatchDir: string,
  spaces: ReadonlyMap<string, string>,
): CrossSpaceTarget | null {
  if (!href) return null;
  if (href.startsWith("#")) return null;
  if (SCHEME_RE.test(href)) return null;
  if (href.startsWith("//")) return null;
  if (href.startsWith("/")) return null;

  const splitAt = href.search(/[#?]/);
  const pathPart = splitAt === -1 ? href : href.slice(0, splitAt);
  const suffix = splitAt === -1 ? "" : href.slice(splitAt);
  if (!pathPart) return null;

  let decoded: string;
  try {
    decoded = pathPart
      .split("/")
      .map((s) => decodeURIComponent(s))
      .join("/");
  } catch {
    return null;
  }

  const articleAbsDir = fsResolve(thisWatchDir, posix.dirname(fromPath));
  const absTarget = fsResolve(articleAbsDir, decoded);

  for (const [otherName, otherDir] of spaces) {
    if (otherName === thisSpaceName) continue;
    const normDir = fsResolve(otherDir);
    if (absTarget === normDir) continue; // bare watch_dir, no file
    if (!absTarget.startsWith(normDir + fsSep)) continue;
    const within = absTarget
      .slice(normDir.length + 1)
      .split(fsSep)
      .join("/");
    if (!within) continue;
    return { space: otherName, path: within, suffix };
  }
  return null;
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
 * Note: the bytes round-trip through `node-html-parser`'s parse →
 * toString, so whitespace, attribute quoting, and self-closing-tag
 * style may differ from the on-disk source. Semantics don't.
 *
 * Idempotent enough for v0: if the page already has an `#arkeon-chrome`
 * element we skip re-injecting (defensive against double-renders, not a
 * real concern since articles on disk never contain one).
 */
export interface InstrumentOpts {
  /**
   * The article's own space's `watch_dir`, absolute. Needed to
   * resolve cross-space relative hrefs against the filesystem.
   * Optional — when omitted (older callers), cross-space rewriting
   * is disabled.
   */
  watchDir?: string;
  /**
   * Every registered space, keyed by name → absolute `watch_dir`.
   * Used to detect cross-space relative hrefs and translate them to
   * the routed `/{space}/{path}` form for http:// click-through.
   * Defaults to an empty map (no cross-space rewriting).
   */
  spaces?: ReadonlyMap<string, string>;
}

export function instrumentArticle(
  html: string,
  fromPath: string,
  knownPaths: Set<string>,
  spaceName: string,
  opts: InstrumentOpts = {},
): string {
  const root = parse(html);
  const watchDir = opts.watchDir;
  const spaces = opts.spaces ?? new Map<string, string>();

  for (const a of root.querySelectorAll("a")) {
    const href = a.getAttribute("href");
    if (!href) continue;

    // Detect cross-space links FIRST: a relative href like
    // `../../work/other/wiki/foo.html` is a perfectly valid
    // filesystem-relative path on disk (file:// follows it) but a
    // 404 over http:// since the daemon serves `/{space}/...`, not
    // `/work/other/...`. Rewrite the rendered href to the routed
    // form so click-through works.
    if (watchDir) {
      const cross = crossSpaceTarget(href, fromPath, spaceName, watchDir, spaces);
      if (cross) {
        const newHref =
          spaceUrlEncode(cross.space, cross.path) + cross.suffix;
        a.setAttribute("href", newHref);
        const className = cross.path.toLowerCase().endsWith(".html")
          ? "arkeon-wiki"
          : "arkeon-file";
        const existing = (a.getAttribute("class") ?? "").trim();
        a.setAttribute(
          "class",
          existing ? `${existing} ${className}` : className,
        );
        continue;
      }
    }

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
 * Render the per-space article index. Rendered in input order — the
 * caller decides the sort (the route picks most-recently-updated first).
 *
 * `label` falls back to the bare filename if missing (the writer is
 * supposed to emit `<title>`, so this is just defensive).
 */
export function renderArticleIndex(
  spaceName: string,
  articles: ArticleIndexRow[],
): string {
  const rows = articles
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
${articles.length === 0 ? empty : rows}
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

/**
 * Build a routed `/{space}/{path}` href with each path segment
 * URL-encoded. Mirrors the construction used in
 * `renderArticleIndex` so the reader's rewritten hrefs hit the same
 * decode path that resolves to entities on the way back in.
 */
function spaceUrlEncode(spaceName: string, path: string): string {
  const encodedPath = path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `/${encodeURIComponent(spaceName)}/${encodedPath}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
