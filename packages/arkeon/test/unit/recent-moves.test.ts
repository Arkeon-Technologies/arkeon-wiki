// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import {
  _clearRecentMovesForTest,
  recordCreateOrMatch,
  recordDeleteOrMatch,
} from "../../src/server/lib/recent-moves.js";

afterEach(() => {
  _clearRecentMovesForTest();
});

describe("recent-moves", () => {
  it("delete-then-create returns a MoveCandidate from the create side", () => {
    expect(recordDeleteOrMatch("demo", "wiki/foo.html", "abc")).toBeNull();
    const move = recordCreateOrMatch("demo", "wiki/foo-renamed.html", "abc");
    expect(move).toEqual({
      oldPath: "wiki/foo.html",
      newPath: "wiki/foo-renamed.html",
    });
  });

  it("create-then-delete returns a MoveCandidate from the delete side", () => {
    expect(recordCreateOrMatch("demo", "wiki/foo-renamed.html", "abc")).toBeNull();
    const move = recordDeleteOrMatch("demo", "wiki/foo.html", "abc");
    expect(move).toEqual({
      oldPath: "wiki/foo.html",
      newPath: "wiki/foo-renamed.html",
    });
  });

  it("matches are space-scoped — same hash in different spaces does not match", () => {
    recordDeleteOrMatch("space-a", "wiki/x.html", "abc");
    expect(recordCreateOrMatch("space-b", "wiki/y.html", "abc")).toBeNull();
  });

  it("non-matching hash does not match", () => {
    recordDeleteOrMatch("demo", "wiki/x.html", "abc");
    expect(recordCreateOrMatch("demo", "wiki/y.html", "different")).toBeNull();
  });

  it("does not match a delete and create at the same path (e.g. content-preserving rewrite)", () => {
    recordDeleteOrMatch("demo", "wiki/x.html", "abc");
    expect(recordCreateOrMatch("demo", "wiki/x.html", "abc")).toBeNull();
  });

  it("a successful match consumes the cache entry", () => {
    recordDeleteOrMatch("demo", "wiki/foo.html", "abc");
    recordCreateOrMatch("demo", "wiki/foo-renamed.html", "abc");
    // A second create against the same hash should not re-fire.
    expect(recordCreateOrMatch("demo", "wiki/foo-another.html", "abc")).toBeNull();
  });

  it("two deletes in a row (no intervening create) just keep the most recent delete", () => {
    recordDeleteOrMatch("demo", "wiki/first.html", "abc");
    recordDeleteOrMatch("demo", "wiki/second.html", "abc");
    const move = recordCreateOrMatch("demo", "wiki/new.html", "abc");
    expect(move).toEqual({ oldPath: "wiki/second.html", newPath: "wiki/new.html" });
  });
});
