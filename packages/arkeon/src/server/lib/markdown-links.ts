// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Extract links from a wiki body. Two flavors are recognized:
 *
 *   1. Standard markdown links — [text](path.md). Resolve to existing
 *      entities. If the target path is unknown, sync logs a warning and
 *      drops the relationship (treat as a typo, not an intentional stub).
 *   2. Wiki-link syntax — [[Label]] or [[Label|subject_type]] (Obsidian /
 *      Roam style). Always resolves through wikiPathFor() and creates a
 *      stub entity if no entity exists at the computed path. This is the
 *      explicit "this thing should exist" marker the agent uses when it
 *      doesn't have a verified path.
 *
 * The parsers are independent — sync calls both and processes each list
 * with the appropriate resolution rules.
 */

export interface MarkdownLink {
  /** Display text of the link. */
  text: string;
  /** Raw href from the markdown (relative path). */
  path: string;
}

export interface WikiLink {
  /** The label inside the brackets, with surrounding whitespace trimmed. */
  label: string;
  /** Optional subject_type hint after a pipe: [[Label|subject_type]]. */
  subject_type?: string;
}

// Matches [text](path) but not ![alt](img) (images)
const LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;

// Matches [[Label]] and [[Label|subject_type]]. Excludes [, ], and | from
// both captures so malformed forms like [[Foo|a|b]] don't accidentally
// match — those are agent typos, not deliberate links.
const WIKILINK_RE = /\[\[([^\[\]|]+)(?:\|([^\[\]|]+))?\]\]/g;

/**
 * Extract all standard markdown links that point to .md files.
 * Returns the display text and raw path for each.
 *
 * Does not match wiki-link syntax `[[Label]]` — use {@link extractWikiLinks}
 * for that.
 */
export function extractMarkdownLinks(content: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  LINK_RE.lastIndex = 0;

  while ((match = LINK_RE.exec(content)) !== null) {
    const text = match[1];
    let path = match[2];

    // Skip URLs and anchors
    if (path.startsWith("http://") || path.startsWith("https://")) continue;
    if (path.startsWith("#")) continue;

    // Strip any anchor fragment from the path
    const hashIndex = path.indexOf("#");
    if (hashIndex !== -1) {
      path = path.slice(0, hashIndex);
    }

    // Only index .md links
    if (!path.endsWith(".md")) continue;

    links.push({ text, path });
  }

  return links;
}

/**
 * Extract `[[Label]]` and `[[Label|subject_type]]` wiki-links.
 *
 * Whitespace around `label` and `subject_type` is trimmed. An empty or
 * whitespace-only label is skipped. The captures exclude `|` so malformed
 * forms like `[[Foo|a|b]]` don't match at all.
 */
export function extractWikiLinks(content: string): WikiLink[] {
  const links: WikiLink[] = [];
  let match: RegExpExecArray | null;

  WIKILINK_RE.lastIndex = 0;

  while ((match = WIKILINK_RE.exec(content)) !== null) {
    const label = match[1].trim();
    if (!label) continue;
    const rawSubject = match[2]?.trim();
    const wikilink: WikiLink = { label };
    if (rawSubject) wikilink.subject_type = rawSubject;
    links.push(wikilink);
  }

  return links;
}

/**
 * Resolve a markdown link path to a space-relative path.
 *
 * Two forms are accepted:
 *
 *   1. Workspace-rooted (preferred). A path starting with "/" means
 *      "relative to the space's watch_dir root". So
 *      `[Watson](/wiki/person/watson.md)` resolves to
 *      `wiki/person/watson.md` regardless of how deep the link's source
 *      file is nested. This is the form the ingestor prompt teaches
 *      the agent because it's stable as the directory tree grows
 *      (e.g. `wiki/<type>/<sub>/<slug>.md` future-proofing) and doesn't
 *      require counting `..` levels. VS Code, Obsidian, and GitHub all
 *      treat `/path` as workspace-rooted in their markdown previewers,
 *      so click-through still works for human readers.
 *
 *   2. Dot-relative (legacy / standard). A path like `../organization/
 *      bell-labs.md` from `wiki/person/claude-shannon.md` resolves to
 *      `wiki/organization/bell-labs.md`. Kept as a fallback so existing
 *      content keeps resolving and so authors who prefer pure-markdown
 *      semantics aren't broken.
 *
 * @param fromPath - Space-relative path of the file containing the link
 * @param linkPath - The raw path from the markdown link
 * @returns Space-relative path of the target, normalized
 */
export function resolveRelativeLink(fromPath: string, linkPath: string): string {
  // Workspace-rooted: ignore the source file's directory entirely.
  if (linkPath.startsWith("/")) {
    return normalizePath(linkPath.slice(1).split("/"));
  }

  // Dot-relative: resolve against the source file's directory.
  const parts = fromPath.split("/");
  parts.pop();
  return normalizePath([...parts, ...linkPath.split("/")]);
}

function normalizePath(parts: string[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}
