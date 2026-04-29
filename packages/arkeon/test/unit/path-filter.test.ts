// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import { shouldTrigger } from "../../src/server/agents/path-filter.js";

describe("shouldTrigger", () => {
  it.each([
    "sources/foo.md",
    "inbox/note.md",
    "deeply/nested/source/file.txt",
    "README.md",
    "data.json",
  ])("triggers for non-wiki path '%s'", (path) => {
    expect(shouldTrigger(path)).toBe(true);
  });

  it.each([
    "wiki/person/shannon.md",
    "wiki/concept/foo.md",
    "wiki/index.md",
    "wiki",                        // bare directory name
  ])("does NOT trigger for wiki path '%s'", (path) => {
    expect(shouldTrigger(path)).toBe(false);
  });

  it.each([
    ".arkeon/state.json",
    ".arkeon/agents.yaml",
    ".arkeon",
  ])("does NOT trigger for internal path '%s'", (path) => {
    expect(shouldTrigger(path)).toBe(false);
  });

  it("normalizes leading slashes", () => {
    expect(shouldTrigger("/sources/foo.md")).toBe(true);
    expect(shouldTrigger("/wiki/foo.md")).toBe(false);
  });

  it("does not match prefixes that aren't directory boundaries", () => {
    // 'wikipedia.md' shouldn't be treated as a wiki path
    expect(shouldTrigger("wikipedia.md")).toBe(true);
    expect(shouldTrigger("notes/wiki-of-mine.md")).toBe(true);
  });
});
