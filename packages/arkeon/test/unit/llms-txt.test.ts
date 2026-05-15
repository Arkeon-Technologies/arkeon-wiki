// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard for the hand-written API guide at /llms.txt and /help.
 * If you add or rename a route, update src/server/lib/llms-txt.ts so
 * these strings are still present.
 */

import { describe, it, expect } from "vitest";

import { LLMS_TXT } from "../../src/server/lib/llms-txt.js";

const REQUIRED_ROUTES = [
  "GET  /health",
  "GET  /ready",
  "GET  /llms.txt",
  "GET  /help",
  "GET  /spaces",
  "POST /spaces",
  "GET  /{space}/entities",
  "GET  /{space}/entities/{path}",
  "GET  /{space}/redlinks",
  "GET  /{space}/recent",
  "GET  /{space}/search",
  "GET  /{space}/sources/scan",
  "POST /{space}/inbox",
  "PUT /{space}/sources/{path}",
  "POST /{space}/agents/{role}/run",
];

const REQUIRED_CONCEPTS = [
  "Space",
  "Entity",
  "Red link",
  "Plan wiki",
  "Properties vs tags",
];

const REQUIRED_AGENT_ROLES = ["editor", "proposer", "writer", "connector"];

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

  for (const role of REQUIRED_AGENT_ROLES) {
    it(`mentions agent role "${role}"`, () => {
      expect(LLMS_TXT).toContain(role);
    });
  }

  it("is plain ASCII-ish text, not HTML", () => {
    expect(LLMS_TXT.startsWith("# arkeon-wiki")).toBe(true);
    expect(LLMS_TXT).not.toContain("<html>");
    expect(LLMS_TXT).not.toContain("<!DOCTYPE");
  });
});
