// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * YAML frontmatter parser/serializer.
 *
 * Wiki files use YAML between --- fences for structured metadata:
 *
 *   ---
 *   id: 01JSG...
 *   label: Claude Shannon
 *   subject_type: person
 *   fields:
 *     - mathematics
 *     - information theory
 *   ---
 *
 *   Markdown body here...
 *
 * We use js-yaml's JSON_SCHEMA so values map cleanly to JSON-compatible types
 * (string, number, bool, null, array, object) and we don't get the "Norway
 * problem" where `country: NO` becomes the boolean false.
 */

import yaml from "js-yaml";

export interface ParsedWiki {
  /** Frontmatter properties (id, label, and arbitrary metadata). */
  properties: Record<string, unknown>;
  /** Markdown body after the frontmatter. */
  body: string;
}

/**
 * Parse a markdown file with YAML frontmatter.
 * Returns the parsed properties and the body content.
 * Throws if the frontmatter is not valid YAML or is not a mapping.
 */
export function parseFrontmatter(content: string): ParsedWiki {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith("---")) {
    return { properties: {}, body: content };
  }

  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1) {
    return { properties: {}, body: content };
  }

  const rest = trimmed.slice(firstNewline + 1);
  const closingIndex = rest.indexOf("\n---");

  if (closingIndex === -1) {
    return { properties: {}, body: content };
  }

  const yamlStr = rest.slice(0, closingIndex);
  const body = rest.slice(closingIndex + 4).replace(/^\n/, "");

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlStr, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    throw new Error(`Invalid YAML in frontmatter: ${(err as Error).message}`);
  }

  if (parsed === null || parsed === undefined) {
    return { properties: {}, body };
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Frontmatter YAML must be a mapping (key: value pairs)");
  }

  return { properties: parsed as Record<string, unknown>, body };
}

/**
 * Serialize properties and body back into a markdown file with YAML frontmatter.
 * Uses block style for readability; preserves insertion order of keys.
 */
export function serializeFrontmatter(properties: Record<string, unknown>, body: string): string {
  const yamlStr = yaml.dump(properties, {
    schema: yaml.JSON_SCHEMA,
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
  }).trimEnd();
  const normalizedBody = body.startsWith("\n") ? body : `\n${body}`;
  return `---\n${yamlStr}\n---\n${normalizedBody}`;
}
