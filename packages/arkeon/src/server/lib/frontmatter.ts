// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * JSON frontmatter parser/serializer.
 *
 * Wiki files use JSON between --- fences for structured metadata:
 *
 *   ---
 *   {
 *     "id": "01JSG...",
 *     "label": "Claude Shannon",
 *     "subject_type": "person"
 *   }
 *   ---
 *
 *   Markdown body here...
 */

export interface ParsedWiki {
  /** Frontmatter properties (id, label, and arbitrary metadata). */
  properties: Record<string, unknown>;
  /** Markdown body after the frontmatter. */
  body: string;
}

/**
 * Parse a markdown file with JSON frontmatter.
 * Returns the parsed properties and the body content.
 * Throws if the frontmatter is not valid JSON.
 */
export function parseFrontmatter(content: string): ParsedWiki {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith("---")) {
    // No frontmatter — treat entire content as body, no properties
    return { properties: {}, body: content };
  }

  // Find the closing ---
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1) {
    return { properties: {}, body: content };
  }

  const rest = trimmed.slice(firstNewline + 1);
  const closingIndex = rest.indexOf("\n---");

  if (closingIndex === -1) {
    // No closing fence — treat as no frontmatter
    return { properties: {}, body: content };
  }

  const jsonStr = rest.slice(0, closingIndex).trim();
  const body = rest.slice(closingIndex + 4).replace(/^\n/, ""); // skip the \n--- and optional leading newline

  let properties: Record<string, unknown>;
  try {
    properties = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Invalid JSON in frontmatter: ${(err as Error).message}`);
  }

  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    throw new Error("Frontmatter JSON must be an object");
  }

  return { properties, body };
}

/**
 * Serialize properties and body back into a markdown file with JSON frontmatter.
 */
export function serializeFrontmatter(properties: Record<string, unknown>, body: string): string {
  const json = JSON.stringify(properties, null, 2);
  // Ensure body has exactly one leading newline after the closing fence
  const normalizedBody = body.startsWith("\n") ? body : `\n${body}`;
  return `---\n${json}\n---\n${normalizedBody}`;
}
