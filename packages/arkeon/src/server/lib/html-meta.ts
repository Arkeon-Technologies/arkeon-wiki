// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parse an HTML document's `<title>` and `<meta name="..." content="...">`
 * tags into the artifact label + properties map. Uses a real HTML parser
 * (`node-html-parser`) rather than regex so attribute-quoting edge cases
 * (apostrophes inside double-quoted values, etc.) work correctly.
 *
 * What we extract:
 *   - The first `<title>` element's text content → `title`
 *   - Every `<meta name="X" content="Y">` → `properties[X] = Y`
 *
 * `<meta>` tags without a `name` attribute (e.g. `<meta charset>`,
 * `<meta http-equiv>`) are ignored.
 */

import { parse } from "node-html-parser";

export interface ParsedHtmlMeta {
  title: string | null;
  properties: Record<string, string>;
}

// Meta names the substrate already claims as top-level artifact columns.
// Hoisting them into `properties` would shadow the top-level field and
// confuse any consumer that walks `artifact.properties` blindly.
const RESERVED_META_NAMES = new Set(["label", "title"]);

export function parseHtmlMeta(html: string): ParsedHtmlMeta {
  const root = parse(html);
  const titleNode = root.querySelector("title");
  const title = titleNode?.text.trim() || null;

  const properties: Record<string, string> = {};
  for (const meta of root.querySelectorAll("meta")) {
    const name = meta.getAttribute("name");
    const content = meta.getAttribute("content");
    if (name && content !== undefined && !RESERVED_META_NAMES.has(name)) {
      properties[name] = content;
    }
  }

  return { title, properties };
}
