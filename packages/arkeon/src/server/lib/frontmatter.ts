// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * YAML frontmatter parser for markdown source files.
 *
 * Wikis post-v0 are HTML and use `<title>` + `<meta>` for metadata
 * (see `html-meta.ts`). This module only services markdown sources
 * that already carry YAML frontmatter — e.g. the Augustine corpus
 * pattern where each section's file has `book: 5, section: 8` etc.
 *
 *   ---
 *   book: 5
 *   section: 8
 *   ---
 *
 *   Confessions text here...
 *
 * Uses js-yaml's JSON_SCHEMA so values map cleanly to JSON-compatible
 * types and we don't get the "Norway problem" (`country: NO` →
 * boolean false).
 *
 * Write-back (the old serializeFrontmatter) is gone — sources are
 * read-only as far as sync is concerned, and wikis don't use YAML.
 */

import yaml from "js-yaml";

export interface ParsedMarkdown {
  /** Frontmatter properties (arbitrary metadata). */
  properties: Record<string, unknown>;
  /** Markdown body after the frontmatter. */
  body: string;
}

/**
 * Parse a markdown file with optional YAML frontmatter.
 * Returns the parsed properties and the body content.
 * A file with no frontmatter returns `{ properties: {}, body: content }`.
 * Throws only on malformed YAML inside a well-formed fence.
 */
export function parseFrontmatter(content: string): ParsedMarkdown {
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
