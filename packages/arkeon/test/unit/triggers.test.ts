// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import {
  compileCondition,
  compileRoleTriggers,
  matches,
  rolesToFire,
} from "../../src/server/agents/triggers.js";
import type { TriggerCondition } from "../../src/server/agents/config.js";

const t = (c: Partial<TriggerCondition>): TriggerCondition => ({
  on: "file_changed",
  path_under: ["**"],
  ...c,
});

describe("trigger condition matching", () => {
  it("path_under: ['**'] matches any path", () => {
    const c = compileCondition(t({ path_under: ["**"] }));
    expect(matches(c, { path: "sources/x.md", by_role: null })).toBe(true);
    expect(matches(c, { path: "wiki/person/y.md", by_role: null })).toBe(true);
    expect(matches(c, { path: "deep/nested/dir/z.txt", by_role: null })).toBe(true);
  });

  it("path_under matches a single glob", () => {
    const c = compileCondition(t({ path_under: ["wiki/**/*.md"] }));
    expect(matches(c, { path: "wiki/person/x.md", by_role: null })).toBe(true);
    expect(matches(c, { path: "wiki/concept/sub/y.md", by_role: null })).toBe(true);
    expect(matches(c, { path: "sources/x.md", by_role: null })).toBe(false);
    expect(matches(c, { path: "wiki/person/x.txt", by_role: null })).toBe(false);
  });

  it("path_not_under excludes paths the positive filter would have allowed", () => {
    const c = compileCondition(
      t({
        path_under: ["**"],
        path_not_under: ["wiki/**", ".arkeon/**"],
      }),
    );
    expect(matches(c, { path: "sources/x.md", by_role: null })).toBe(true);
    expect(matches(c, { path: "wiki/person/x.md", by_role: null })).toBe(false);
    expect(matches(c, { path: ".arkeon/state.json", by_role: null })).toBe(false);
  });

  it("path_not_under matches dotfiles when path uses leading dot (dot:true)", () => {
    const c = compileCondition(
      t({ path_under: ["**"], path_not_under: [".arkeon/**"] }),
    );
    expect(matches(c, { path: ".arkeon/agents.yaml", by_role: null })).toBe(false);
  });

  // ── attribution filters ────────────────────────────────────────

  it("by_role positive filter only fires when the latest editor matches", () => {
    const c = compileCondition(
      t({ path_under: ["wiki/**"], by_role: ["synthesizer"] }),
    );
    expect(matches(c, { path: "wiki/x.md", by_role: "synthesizer" })).toBe(true);
    expect(matches(c, { path: "wiki/x.md", by_role: "ingestor" })).toBe(false);
    expect(matches(c, { path: "wiki/x.md", by_role: null })).toBe(false);
  });

  it("by_role_not negative filter rejects edits by the listed roles", () => {
    const c = compileCondition(
      t({ path_under: ["wiki/**"], by_role_not: ["synthesizer"] }),
    );
    expect(matches(c, { path: "wiki/x.md", by_role: "ingestor" })).toBe(true);
    expect(matches(c, { path: "wiki/x.md", by_role: "human" })).toBe(true);
    expect(matches(c, { path: "wiki/x.md", by_role: "synthesizer" })).toBe(false);
  });

  it("by_role_not allows null by_role (a brand-new file with no audit row)", () => {
    const c = compileCondition(
      t({ path_under: ["**"], by_role_not: ["ingestor"] }),
    );
    expect(matches(c, { path: "sources/new.md", by_role: null })).toBe(true);
  });

  it("by_role and by_role_not can be combined; positive applied first", () => {
    const c = compileCondition(
      t({
        path_under: ["wiki/**"],
        by_role: ["synthesizer", "human"],
        by_role_not: ["human"],
      }),
    );
    expect(matches(c, { path: "wiki/x.md", by_role: "synthesizer" })).toBe(true);
    // human is in positive but also in negative → rejected
    expect(matches(c, { path: "wiki/x.md", by_role: "human" })).toBe(false);
    // not in positive → rejected
    expect(matches(c, { path: "wiki/x.md", by_role: "ingestor" })).toBe(false);
  });
});

describe("rolesToFire", () => {
  it("returns the roles whose triggers match", () => {
    const compiled = compileRoleTriggers([
      {
        role: "ingestor",
        triggers: [
          {
            on: "file_changed",
            path_under: ["**"],
            path_not_under: ["wiki/**", ".arkeon/**"],
          },
        ],
      },
      {
        role: "synthesizer",
        triggers: [
          {
            on: "file_changed",
            path_under: ["wiki/**/*.md"],
            by_role_not: ["synthesizer"],
          },
        ],
      },
    ]);

    expect(
      rolesToFire(compiled, { path: "sources/x.txt", by_role: null }),
    ).toEqual(["ingestor"]);

    expect(
      rolesToFire(compiled, { path: "wiki/person/x.md", by_role: "ingestor" }),
    ).toEqual(["synthesizer"]);

    // Synthesizer's own writes shouldn't fire it.
    expect(
      rolesToFire(compiled, { path: "wiki/person/x.md", by_role: "synthesizer" }),
    ).toEqual([]);

    // .arkeon excluded by ingestor; not under wiki for synthesizer → nobody fires.
    expect(
      rolesToFire(compiled, { path: ".arkeon/agents.yaml", by_role: null }),
    ).toEqual([]);
  });

  it("dedupes a role that has multiple matching conditions", () => {
    const compiled = compileRoleTriggers([
      {
        role: "ingestor",
        triggers: [
          { on: "file_changed", path_under: ["sources/**"] },
          { on: "file_changed", path_under: ["**/*.txt"] },
        ],
      },
    ]);
    expect(
      rolesToFire(compiled, { path: "sources/x.txt", by_role: null }),
    ).toEqual(["ingestor"]);
  });
});
