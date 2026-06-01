// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard for /llms.txt + /help. When you change a route shape,
 * update src/server/lib/llms-txt.ts so these strings stay present.
 */

import { describe, it, expect } from "vitest";

import { LLMS_TXT } from "../../src/server/lib/llms-txt.js";

const REQUIRED_ROUTES = [
  "POST /query",
  "POST /tag",
  "POST /untag",
  "GET /tags",
  "GET /backlinks",
  "GET /redlinks",
  "GET /<path>",
];

const REQUIRED_CONCEPTS = [
  "artifacts",
  "tags",
  "links",
  "fts_artifacts",
  "wikilink",
  ".sidecars/",
  "data-*",
];

describe("llms.txt", () => {
  for (const route of REQUIRED_ROUTES) {
    it(`mentions ${route}`, () => {
      expect(LLMS_TXT).toContain(route);
    });
  }

  for (const concept of REQUIRED_CONCEPTS) {
    it(`mentions concept "${concept}"`, () => {
      expect(LLMS_TXT).toContain(concept);
    });
  }

  it("is plain text, not HTML", () => {
    expect(LLMS_TXT.startsWith("# arkeon-wiki")).toBe(true);
    expect(LLMS_TXT).not.toContain("<html>");
    expect(LLMS_TXT).not.toContain("<!DOCTYPE");
  });
});
