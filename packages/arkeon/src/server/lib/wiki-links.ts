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

export interface WikiLinkParseErrorDetail {
  raw: string;
  offset: number;
  reason: string;
}

export class WikiLinkParseError extends Error {
  details: WikiLinkParseErrorDetail[];

  constructor(details: WikiLinkParseErrorDetail[]) {
    super("Malformed wiki links");
    this.name = "WikiLinkParseError";
    this.details = details;
  }
}

// Matches every bracketed wiki link. Each block is then validated strictly.
const BRACKET_LINK_RE = /\[\[([^\]]*)\]\]/g;

// Matches "quoted" with optional |"quoted"
const QUOTED_RE = /^"([^"]*)"(?:\|"([^"]*)")?$/;
const ENTITY_ID_RE = /^[A-Za-z0-9_-]+$/;

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
  const errors: WikiLinkParseErrorDetail[] = [];
  const matchedOffsets = new Set<number>();

  let match: RegExpExecArray | null;
  // Reset lastIndex since we reuse the global regex.
  BRACKET_LINK_RE.lastIndex = 0;

  while ((match = BRACKET_LINK_RE.exec(content)) !== null) {
    const inner = match[1]!.trim();
    const offset = match.index;
    const length = match[0].length;
    const raw = match[0];
    matchedOffsets.add(offset);
    const colon = inner.indexOf(":");

    if (colon <= 0) {
      errors.push({
        raw,
        offset,
        reason:
          'Expected typed link like [[entity:ULID]], [[resolve:"Label"|"Description"]], [[draft:"Label"|"Description"]], or [[gap:"Label"|"Description"]]. See GET /help/guide/wiki.',
      });
      continue;
    }

    const typeText = inner.slice(0, colon);
    const body = inner.slice(colon + 1).trim();
    if (!isLinkType(typeText)) {
      errors.push({
        raw,
        offset,
        reason: `Unknown wiki link type "${typeText}". Valid types are: entity, resolve, draft, gap. See GET /help/guide/wiki.`,
      });
      continue;
    }
    if (!body) {
      errors.push({ raw, offset, reason: "Link target cannot be empty" });
      continue;
    }

    let type = typeText;

    // Promote draft → gap at max depth
    if (type === "draft" && depth >= maxDepth) {
      type = "gap";
    }

    const spanText = extractSpanText(content, offset, length);

    if (type === "entity") {
      if (!ENTITY_ID_RE.test(body)) {
        errors.push({ raw, offset, reason: "entity links must use an unquoted entity ID" });
        continue;
      }
      links.push({ type, raw, offset, length, id: body, spanText });
    } else {
      const quoted = QUOTED_RE.exec(body);
      if (!quoted) {
        errors.push({ raw, offset, reason: `${type}: links must use quoted syntax: [[${type}:\"Label\"|\"Description\"]]` });
        continue;
      }
      if (!quoted[1]) {
        errors.push({ raw, offset, reason: "Link label cannot be empty" });
        continue;
      }
      links.push({
        type,
        raw,
        offset,
        length,
        label: quoted[1]!,
        description: quoted[2] ?? undefined,
        spanText,
      });
    }
  }

  let openOffset = content.indexOf("[[");
  while (openOffset !== -1) {
    if (!matchedOffsets.has(openOffset)) {
      errors.push({
        raw: content.slice(openOffset, Math.min(content.length, openOffset + 80)),
        offset: openOffset,
        reason: "Unclosed wiki link — every [[ must be closed with ]]. If you meant this literally, use alternative delimiters (e.g. <<...>>).",
      });
    }
    openOffset = content.indexOf("[[", openOffset + 2);
  }

  if (errors.length > 0) {
    throw new WikiLinkParseError(errors);
  }

  return links;
}

function isLinkType(value: string): value is LinkType {
  return value === "entity" || value === "resolve" || value === "draft" || value === "gap";
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
