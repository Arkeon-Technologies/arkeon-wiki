// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Extract standard markdown links from content.
 *
 * Finds [text](path) links where path ends in .md — these are wiki
 * cross-references that become relationship edges in Postgres.
 * Ignores URLs (http://, https://), anchors (#), and non-.md links.
 */

export interface MarkdownLink {
  /** Display text of the link. */
  text: string;
  /** Raw href from the markdown (relative path). */
  path: string;
}

// Matches [text](path) but not ![alt](img) (images)
const LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Extract all markdown links that point to .md files.
 * Returns the display text and raw path for each.
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
 * Resolve a relative link path to a space-relative path.
 *
 * Given a wiki file at `wiki/person/claude-shannon.md` containing a link
 * `../organization/bell-labs.md`, this resolves to
 * `wiki/organization/bell-labs.md`.
 *
 * @param fromPath - Space-relative path of the file containing the link
 * @param linkPath - The raw relative path from the markdown link
 * @returns Space-relative path of the target, normalized
 */
export function resolveRelativeLink(fromPath: string, linkPath: string): string {
  // Get the directory of the source file
  const parts = fromPath.split("/");
  parts.pop(); // remove filename
  const dir = parts;

  // Resolve the relative path
  const linkParts = linkPath.split("/");
  const resolved = [...dir];

  for (const part of linkParts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== ".") {
      resolved.push(part);
    }
  }

  return resolved.join("/");
}
