// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Extract links from a wiki body. Two flavors are recognized:
 *
 *   1. Standard markdown links — [text](path.md). Resolve to existing
 *      entities. If the target path is unknown, sync logs a warning and
 *      drops the relationship (treat as a typo, not an intentional
 *      placeholder).
 *   2. Wiki-link syntax — [[Label]] or [[Label|subject_type]] (Obsidian /
 *      Roam style). Always resolves through wikiPathFor() and creates a
 *      placeholder wiki (type='wiki' with source_hash IS NULL — no file
 *      on disk yet) if no entity exists at the computed path. This is
 *      the explicit "this thing should exist" marker the agent uses when
 *      it doesn't have a verified path.
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
  /**
   * Optional target-space hint via the `space:NAME` marker:
   *   [[Label|space:research-notes]]
   *   [[Label|subject_type|space:research-notes]]
   * Cross-space wikilinks must resolve to an existing wiki — they never
   * create placeholders in the target space (writes always stay scoped
   * to the source wiki's own space; #99 read-only-across-spaces holds
   * for placeholder allocation too). Resolver logic lives in
   * `sync.ts:rebuildRelationships`.
   */
  space?: string;
}

// Matches [text](path) but not ![alt](img) (images)
const LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;

// Matches [[Label]], [[Label|seg]], and [[Label|seg|seg]]. Each segment
// excludes [, ], and | so malformed forms like [[Foo|a|b|c]] don't match
// — those are agent typos, not deliberate links. The two optional
// segments are sniffed by extractWikiLinks: a `space:` prefix marks the
// target-space hint, anything else is treated as the subject_type.
const WIKILINK_RE = /\[\[([^\[\]|]+)(?:\|([^\[\]|]+))?(?:\|([^\[\]|]+))?\]\]/g;

const SPACE_PREFIX = "space:";

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
 * Extract `[[Label]]`, `[[Label|subject_type]]`, and the cross-space
 * variants `[[Label|space:NAME]]` and `[[Label|subject_type|space:NAME]]`.
 *
 * Each pipe segment is sniffed by prefix: `space:NAME` becomes the target
 * space hint, anything else becomes the `subject_type`. Position doesn't
 * matter — `[[X|space:Y|t]]` parses the same as `[[X|t|space:Y]]`. A
 * second `space:` segment, or a second non-space segment, is rejected as
 * malformed (silently dropped — agent typos, not deliberate links).
 *
 * Whitespace around `label`, `subject_type`, and the space name is
 * trimmed. An empty or whitespace-only label is skipped. The captures
 * exclude `|`, `[`, `]` so a four-segment `[[Foo|a|b|c]]` doesn't match.
 */
export function extractWikiLinks(content: string): WikiLink[] {
  const links: WikiLink[] = [];
  let match: RegExpExecArray | null;

  WIKILINK_RE.lastIndex = 0;

  while ((match = WIKILINK_RE.exec(content)) !== null) {
    const label = match[1].trim();
    if (!label) continue;

    let subjectType: string | undefined;
    let space: string | undefined;
    let malformed = false;

    for (const raw of [match[2], match[3]]) {
      const seg = raw?.trim();
      if (!seg) continue;
      if (seg.startsWith(SPACE_PREFIX)) {
        const name = seg.slice(SPACE_PREFIX.length).trim();
        if (!name || space !== undefined) {
          // Empty `space:`, or two `space:` segments. Either way the
          // intent is unclear; treat as a typo and skip the whole link.
          malformed = true;
          break;
        }
        space = name;
      } else {
        if (subjectType !== undefined) {
          // Two non-space segments — `[[Foo|a|b]]` with no space marker.
          // Same treatment as the legacy malformed-multi-pipe case.
          malformed = true;
          break;
        }
        subjectType = seg;
      }
    }

    if (malformed) continue;

    const wikilink: WikiLink = { label };
    if (subjectType) wikilink.subject_type = subjectType;
    if (space) wikilink.space = space;
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
