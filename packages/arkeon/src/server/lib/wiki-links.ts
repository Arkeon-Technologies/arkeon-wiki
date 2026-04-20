// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parser for typed wiki links in markdown content.
 *
 * Link syntax:
 *   [[entity:e_01ARZ3NDEKTSV4RRFFQ69G5FAV]]     — known entity by ID
 *   [[resolve:"Label"|"Description"]]           — let the server find a match; falls back to placeholder on miss / no LLM
 *   [[placeholder:"Label"|"Description"]]       — unwritten stub. Not queued. May be left or filled later.
 *   [[assign:"Label"|"Description"]]            — hand off to the background drafter. Queued for auto-drafting.
 *
 * Quoting is flexible for resolve/placeholder/assign links — both quoted
 * and unquoted forms are accepted (LLMs commonly drop quotes):
 *   [[resolve:"Label"|"Description"]]           — canonical (fully quoted)
 *   [[resolve:"Label"|Description]]             — description unquoted
 *   [[resolve:Label|Description]]               — fully unquoted
 *   [[resolve:Label]]                           — label only, no description
 *
 * At depth >= maxDepth, assign: links are demoted to placeholder: (no further
 * recursive queueing — prevents unbounded fan-out).
 */

export type LinkType = "entity" | "resolve" | "placeholder" | "assign";

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
  /** For resolve/placeholder/assign links — the label */
  label?: string;
  /** For resolve/placeholder/assign links — optional description */
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

// Matches label|description in several forms:
//   "Label"|"Description"     — fully quoted (canonical)
//   "Label"|Description       — label quoted, description unquoted
//   "Label"                   — label only, no description
//   Label|Description         — fully unquoted
//   Label                     — label only, unquoted
const QUOTED_RE = /^"([^"]*)"(?:\|"([^"]*)")?$/;
const FLEXIBLE_RE = /^"([^"]+)"(?:\|(.+))?$|^([^|]+?)(?:\|(.+))?$/;
const ENTITY_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Parse all typed links from wiki markdown content.
 *
 * When depth >= maxDepth, assign: links are demoted to placeholder: links
 * so no new draft work is queued.
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
          'Expected typed link like [[entity:ULID]], [[resolve:"Label"|"Description"]], [[placeholder:"Label"|"Description"]], or [[assign:"Label"|"Description"]]. See GET /help/guide/wiki.',
      });
      continue;
    }

    const typeText = inner.slice(0, colon);
    const body = inner.slice(colon + 1).trim();
    if (!isLinkType(typeText)) {
      errors.push({
        raw,
        offset,
        reason: `Unknown wiki link type "${typeText}". Valid types: entity, resolve, placeholder, assign. See GET /help/guide/wiki.`,
      });
      continue;
    }
    if (!body) {
      errors.push({ raw, offset, reason: "Link target cannot be empty" });
      continue;
    }

    let type = typeText;

    // Demote assign → placeholder at max depth. Stops runaway recursive
    // queueing when a background drafter's own output references more
    // assigns — further levels become inert stubs.
    if (type === "assign" && depth >= maxDepth) {
      type = "placeholder";
    }

    const spanText = extractSpanText(content, offset, length);

    if (type === "entity") {
      if (!ENTITY_ID_RE.test(body)) {
        errors.push({ raw, offset, reason: "entity links must use an unquoted entity ID" });
        continue;
      }
      links.push({ type, raw, offset, length, id: body, spanText });
    } else {
      // Accept both quoted and unquoted label|description forms.
      // LLMs commonly drop quotes, so we parse flexibly:
      //   "Label"|"Description"  — canonical
      //   "Label"|Description    — description unquoted
      //   Label|Description      — fully unquoted
      //   "Label" or Label       — no description
      const flex = FLEXIBLE_RE.exec(body);
      if (!flex) {
        errors.push({ raw, offset, reason: `${type}: could not parse label from [[${type}:...]]` });
        continue;
      }
      // flex[1] = quoted label, flex[2] = description after quoted label
      // flex[3] = unquoted label, flex[4] = description after unquoted label
      const label = (flex[1] ?? flex[3] ?? "").trim();
      const descRaw = (flex[2] ?? flex[4] ?? "").trim();
      // Strip surrounding quotes from description if present
      const description = descRaw.replace(/^"|"$/g, "").trim() || undefined;
      if (!label) {
        errors.push({ raw, offset, reason: "Link label cannot be empty" });
        continue;
      }
      links.push({ type, raw, offset, length, label, description, spanText });
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
  return (
    value === "entity" ||
    value === "resolve" ||
    value === "placeholder" ||
    value === "assign"
  );
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

