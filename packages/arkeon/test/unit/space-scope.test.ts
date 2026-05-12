// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import {
  resolveAllowedSpaces,
  resolveSpaceArg,
} from "../../src/server/agents/space-scope.js";
import type { Space } from "../../src/server/lib/sync.js";
import type { SqlClient } from "../../src/server/lib/sql.js";

interface SpaceRow {
  name: string;
  watch_dir: string;
}

function mockSql(spaces: SpaceRow[]): SqlClient {
  const fn = (async () => spaces) as unknown as SqlClient;
  fn.query = (async () => spaces) as SqlClient["query"];
  return fn;
}

describe("resolveAllowedSpaces", () => {
  const own: Space = { name: "demo", watch_dir: "/tmp/demo" };
  const rows: SpaceRow[] = [
    { name: "demo", watch_dir: "/tmp/demo" },
    { name: "research", watch_dir: "/tmp/research" },
    { name: "notes", watch_dir: "/tmp/notes" },
  ];

  it("defaults to ['self'] — just the triggering space", async () => {
    const sql = mockSql(rows);
    const result = await resolveAllowedSpaces(undefined, own, { sql });
    expect(result.map((s) => s.name)).toEqual(["demo"]);
  });

  it("expands ['*'] to every registered space, with own first", async () => {
    const sql = mockSql(rows);
    const result = await resolveAllowedSpaces(["*"], own, { sql });
    expect(result.map((s) => s.name)).toEqual(["demo", "research", "notes"]);
  });

  it("allows '*' combined with 'self' (no-op companion)", async () => {
    const sql = mockSql(rows);
    const result = await resolveAllowedSpaces(["*", "self"], own, { sql });
    expect(result.map((s) => s.name)).toEqual(["demo", "research", "notes"]);
  });

  it("rejects '*' combined with named entries", async () => {
    const sql = mockSql(rows);
    await expect(resolveAllowedSpaces(["*", "research"], own, { sql }))
      .rejects.toThrow(/"\*" cannot be combined/);
  });

  it("resolves named spaces in YAML order, own first", async () => {
    const sql = mockSql(rows);
    const result = await resolveAllowedSpaces(["research", "notes"], own, { sql });
    expect(result.map((s) => s.name)).toEqual(["demo", "research", "notes"]);
  });

  it("dedupes when a named entry already includes own/another", async () => {
    const sql = mockSql(rows);
    const result = await resolveAllowedSpaces(["self", "research", "research"], own, { sql });
    expect(result.map((s) => s.name)).toEqual(["demo", "research"]);
  });

  it("throws on unknown name", async () => {
    const sql = mockSql(rows);
    await expect(resolveAllowedSpaces(["nonexistent"], own, { sql }))
      .rejects.toThrow(/did not match any registered space/);
  });
});

describe("resolveSpaceArg", () => {
  const spaces: Space[] = [
    { name: "demo", watch_dir: "/d" },
    { name: "research", watch_dir: "/r" },
  ];

  it("matches by name", () => {
    expect(resolveSpaceArg("demo", spaces).name).toBe("demo");
    expect(resolveSpaceArg("research", spaces).name).toBe("research");
  });

  it("trims whitespace", () => {
    expect(resolveSpaceArg("  demo  ", spaces).name).toBe("demo");
  });

  it("throws on empty arg", () => {
    expect(() => resolveSpaceArg("", spaces)).toThrow(/cannot be empty/);
    expect(() => resolveSpaceArg("   ", spaces)).toThrow(/cannot be empty/);
  });

  it("throws on unknown name", () => {
    expect(() => resolveSpaceArg("nope", spaces)).toThrow(/not in the allowed set/);
  });
});
