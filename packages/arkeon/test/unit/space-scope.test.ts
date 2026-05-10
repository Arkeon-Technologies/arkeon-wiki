// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  describeAllowed,
  resolveAllowedSpaces,
  resolveSpaceArg,
} from "../../src/server/agents/space-scope.js";
import type { SqlClient } from "../../src/server/lib/sql.js";
import type { Space } from "../../src/server/lib/sync.js";

// Build a fake SqlClient that always returns the same rows for the
// `SELECT id, name, watch_dir FROM spaces ...` query the resolver
// runs. The resolver only ever uses the tagged-template form, so we
// only have to stub that signature.
function fakeSql(rows: Array<{ id: string; name: string; watch_dir: string }>): SqlClient {
  const fn = (() => Promise.resolve(rows)) as unknown as SqlClient;
  fn.query = async () => rows;
  return fn;
}

const own: Space = {
  id: "space-own",
  name: "own",
  watch_dir: "/tmp/own",
};

const sibling = {
  id: "space-sib",
  name: "data-mining",
  watch_dir: "/tmp/data-mining",
};

const dupA = {
  id: "space-dup-a",
  name: "duplicate",
  watch_dir: "/tmp/dup-a",
};

const dupB = {
  id: "space-dup-b",
  name: "duplicate",
  watch_dir: "/tmp/dup-b",
};

const ownRow = {
  id: own.id,
  name: own.name,
  watch_dir: own.watch_dir,
};

describe("resolveAllowedSpaces", () => {
  it("defaults to [self] when scope is undefined", async () => {
    const result = await resolveAllowedSpaces(undefined, own, {
      sql: fakeSql([ownRow, sibling]),
    });
    expect(result).toEqual([own]);
  });

  it("defaults to [self] when scope is empty array", async () => {
    const result = await resolveAllowedSpaces([], own, {
      sql: fakeSql([ownRow, sibling]),
    });
    expect(result).toEqual([own]);
  });

  it("expands `self` to the triggering space", async () => {
    const result = await resolveAllowedSpaces(["self"], own, {
      sql: fakeSql([ownRow]),
    });
    expect(result).toEqual([own]);
  });

  it("resolves a sibling by name", async () => {
    const result = await resolveAllowedSpaces(["self", "data-mining"], own, {
      sql: fakeSql([ownRow, sibling]),
    });
    expect(result.map((s) => s.id)).toEqual([own.id, sibling.id]);
  });

  it("resolves a sibling by id", async () => {
    const result = await resolveAllowedSpaces(["self", sibling.id], own, {
      sql: fakeSql([ownRow, sibling]),
    });
    expect(result.map((s) => s.id)).toEqual([own.id, sibling.id]);
  });

  it("expands `*` to every registered space, with self first", async () => {
    const result = await resolveAllowedSpaces(["*"], own, {
      sql: fakeSql([ownRow, sibling, dupA]),
    });
    expect(result[0].id).toBe(own.id);
    expect(result.map((s) => s.id).sort()).toEqual(
      [own.id, sibling.id, dupA.id].sort(),
    );
  });

  it("always includes the triggering space even when scope omits it", async () => {
    // Operator wrote `spaces: ["data-mining"]` — a role can still see
    // its own space.
    const result = await resolveAllowedSpaces(["data-mining"], own, {
      sql: fakeSql([ownRow, sibling]),
    });
    expect(result[0].id).toBe(own.id);
    expect(result.map((s) => s.id)).toContain(sibling.id);
  });

  it("dedupes redundant entries", async () => {
    const result = await resolveAllowedSpaces(
      ["self", own.id, "data-mining", sibling.id],
      own,
      { sql: fakeSql([ownRow, sibling]) },
    );
    expect(result).toHaveLength(2);
  });

  it("throws on an unknown name", async () => {
    await expect(
      resolveAllowedSpaces(["nope"], own, { sql: fakeSql([ownRow]) }),
    ).rejects.toThrow(/did not match/);
  });

  it("throws on an ambiguous name with the candidate ids", async () => {
    const promise = resolveAllowedSpaces(["duplicate"], own, {
      sql: fakeSql([ownRow, dupA, dupB]),
    });
    await expect(promise).rejects.toThrow(/ambiguous/);
    await expect(promise).rejects.toThrow(dupA.id);
    await expect(promise).rejects.toThrow(dupB.id);
  });
});

describe("resolveSpaceArg", () => {
  it("matches by id", () => {
    expect(resolveSpaceArg(sibling.id, [own, sibling])).toBe(sibling);
  });

  it("matches by name when unique", () => {
    expect(resolveSpaceArg("data-mining", [own, sibling]).id).toBe(sibling.id);
  });

  it("rejects a name not in the allowed set", () => {
    expect(() => resolveSpaceArg("intruder", [own])).toThrow(/not in the allowed set/);
  });

  it("flags an ambiguous name within the allowed set", () => {
    expect(() => resolveSpaceArg("duplicate", [dupA, dupB])).toThrow(/ambiguous/);
  });

  it("rejects an empty string", () => {
    expect(() => resolveSpaceArg("", [own])).toThrow(/cannot be empty/);
  });

  it("trims whitespace before matching", () => {
    expect(resolveSpaceArg("  data-mining ", [own, sibling]).id).toBe(sibling.id);
  });
});

describe("describeAllowed", () => {
  it("renders 'name (id)' for each space, comma-separated", () => {
    expect(describeAllowed([own, sibling])).toBe(
      `own (${own.id}), data-mining (${sibling.id})`,
    );
  });

  it("returns '(none)' when empty", () => {
    expect(describeAllowed([])).toBe("(none)");
  });
});
