// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parser for typed wiki links in markdown content.
 *
 * Link syntax:
 *   [[entity:e_01ARZ3NDEKTSV4RRFFQ69G5FAV]]   — known entity by ID
 *   [[resolve:"Label"|"Description"]]           — find existing or create
 *   [[resolve:"Label"]]                         — find existing or create (no description)
 *   [[draft:"Label"|"Description"]]             — placeholder, author will draft
 *   [[gap:"Label"|"Description"]]               — marker, no draft commitment
 *
 * At depth >= maxDepth, draft: links are automatically promoted to gap: links.
 */

export type LinkType = "entity" | "resolve" | "draft" | "gap";

export interface ParsedLink {
  type: LinkType;
  /** The original raw match including [[ and ]] */
  raw: string;
  /** Character offset of the [[ in the source content */
  offset: number;
  /** Length of the full match */
  length: number;
  /** For entity: links — the entity ID */
  id?: string;
  /** For resolve/draft/gap: links — the label */
  label?: string;
  /** For resolve/draft/gap: links — optional description */
  description?: string;
  /** Surrounding prose context */
  spanText: string;
}

// Matches [[type:content]] where type is one of the four link types.
// Content is either:
//   - A bare ID (for entity:)
//   - "quoted string" optionally followed by |"quoted string" (for resolve/draft/gap)
const LINK_RE = /\[\[(entity|resolve|draft|gap):([^\]]+)\]\]/g;

// Matches "quoted" with optional |"quoted"
const QUOTED_RE = /^"([^"]*)"(?:\|"([^"]*)")?$/;

/**
 * Parse all typed links from wiki markdown content.
 *
 * When depth >= maxDepth, draft: links are promoted to gap: links
 * so no new placeholders are created.
 */
export function parseWikiLinks(
  content: string,
  depth: number,
  maxDepth: number,
): ParsedLink[] {
  const links: ParsedLink[] = [];

  let match: RegExpExecArray | null;
  // Reset lastIndex since we reuse the global regex
  LINK_RE.lastIndex = 0;

  while ((match = LINK_RE.exec(content)) !== null) {
    let type = match[1] as LinkType;
    const body = match[2]!.trim();
    const offset = match.index;
    const length = match[0].length;
    const raw = match[0];

    // Promote draft → gap at max depth
    if (type === "draft" && depth >= maxDepth) {
      type = "gap";
    }

    const spanText = extractSpanText(content, offset, length);

    if (type === "entity") {
      links.push({ type, raw, offset, length, id: body, spanText });
    } else {
      const quoted = QUOTED_RE.exec(body);
      if (quoted) {
        links.push({
          type,
          raw,
          offset,
          length,
          label: quoted[1]!,
          description: quoted[2] ?? undefined,
          spanText,
        });
      } else {
        // Unquoted fallback — treat entire body as label
        links.push({ type, raw, offset, length, label: body, spanText });
      }
    }
  }

  return links;
}

/**
 * Extract surrounding prose context around a link.
 * Returns ~contextChars characters before and after the link.
 */
export function extractSpanText(
  content: string,
  offset: number,
  length: number,
  contextChars = 200,
): string {
  const start = Math.max(0, offset - contextChars);
  const end = Math.min(content.length, offset + length + contextChars);
  return content.slice(start, end);
}

// TODO(phase-2): draft worker processes queued placeholders created from draft: links
