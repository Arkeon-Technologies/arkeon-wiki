// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  applyLinkReplacements,
  diffWikiReferences,
  type ExistingRelationship,
  type LinkTarget,
} from "../../src/server/lib/wiki-pipeline";

describe("applyLinkReplacements", () => {
  test("returns content unchanged when no replacements", () => {
    const content = "Hello [[entity:ABC123]] world";
    expect(applyLinkReplacements(content, [])).toBe(content);
  });

  test("replaces a single link", () => {
    const content = '[[resolve:"Foo"|"Bar"]]';
    const result = applyLinkReplacements(content, [
      { offset: 0, length: content.length, value: "[[entity:01ABC]]" },
    ]);
    expect(result).toBe("[[entity:01ABC]]");
  });

  test("replaces multiple links preserving order", () => {
    const content = 'See [[resolve:"A"|"x"]] and [[assign:"B"|"y"]] end';
    const resolveOffset = content.indexOf("[[resolve:");
    const resolveLen = '[[resolve:"A"|"x"]]'.length;
    const assignOffset = content.indexOf("[[assign:");
    const assignLen = '[[assign:"B"|"y"]]'.length;

    const result = applyLinkReplacements(content, [
      { offset: resolveOffset, length: resolveLen, value: "[[entity:ID1]]" },
      { offset: assignOffset, length: assignLen, value: "[[entity:ID2]]" },
    ]);

    expect(result).toBe("See [[entity:ID1]] and [[entity:ID2]] end");
  });

  test("handles replacements of different lengths", () => {
    const content = 'X [[resolve:"Short"]] Y [[assign:"Very Long Description"|"Extra"]] Z';
    const r1Offset = content.indexOf("[[resolve:");
    const r1Len = '[[resolve:"Short"]]'.length;
    const r2Offset = content.indexOf("[[assign:");
    const r2Len = '[[assign:"Very Long Description"|"Extra"]]'.length;

    const result = applyLinkReplacements(content, [
      { offset: r1Offset, length: r1Len, value: "[[entity:A]]" },
      { offset: r2Offset, length: r2Len, value: "[[entity:B]]" },
    ]);

    expect(result).toBe("X [[entity:A]] Y [[entity:B]] Z");
  });

  test("processes replacements from end to start (offset-safe)", () => {
    // Verify that earlier replacements don't corrupt later offsets
    const content = "AB[[x:1]]CD[[y:2]]EF";
    const result = applyLinkReplacements(content, [
      { offset: 2, length: 7, value: "REPLACED1" },
      { offset: 11, length: 7, value: "REPLACED2" },
    ]);
    expect(result).toBe("ABREPLACED1CDREPLACED2EF");
  });
});

describe("diffWikiReferences", () => {
  const makeExisting = (overrides: Partial<ExistingRelationship> & { targetId: string }): ExistingRelationship => ({
    id: `rel-${overrides.targetId}`,
    predicate: "references",
    spanText: "",
    ...overrides,
  });

  const makeTarget = (overrides: Partial<LinkTarget> & { targetId: string }): LinkTarget => ({
    predicate: "references",
    spanText: "",
    ...overrides,
  });

  test("empty existing + empty new = no changes", () => {
    const diff = diffWikiReferences([], []);
    expect(diff.toUpdate).toEqual([]);
    expect(diff.toCreate).toEqual([]);
    expect(diff.toDelete).toEqual([]);
  });

  test("empty existing + new targets = all creates", () => {
    const targets: LinkTarget[] = [
      makeTarget({ targetId: "E1", spanText: "about E1" }),
      makeTarget({ targetId: "E2", spanText: "about E2" }),
    ];

    const diff = diffWikiReferences([], targets);

    expect(diff.toCreate).toEqual(targets);
    expect(diff.toUpdate).toEqual([]);
    expect(diff.toDelete).toEqual([]);
  });

  test("existing with no new targets = all deletes", () => {
    const existing: ExistingRelationship[] = [
      makeExisting({ targetId: "E1" }),
      makeExisting({ targetId: "E2" }),
    ];

    const diff = diffWikiReferences(existing, []);

    expect(diff.toDelete).toEqual(["rel-E1", "rel-E2"]);
    expect(diff.toCreate).toEqual([]);
    expect(diff.toUpdate).toEqual([]);
  });

  test("same target = update span_text", () => {
    const existing: ExistingRelationship[] = [
      makeExisting({ targetId: "E1", spanText: "old context" }),
    ];
    const targets: LinkTarget[] = [
      makeTarget({ targetId: "E1", spanText: "new context" }),
    ];

    const diff = diffWikiReferences(existing, targets);

    expect(diff.toUpdate).toEqual([{ id: "rel-E1", spanText: "new context" }]);
    expect(diff.toCreate).toEqual([]);
    expect(diff.toDelete).toEqual([]);
  });

  test("mixed: keep + create + delete", () => {
    const existing: ExistingRelationship[] = [
      makeExisting({ targetId: "KEEP", spanText: "old" }),
      makeExisting({ targetId: "DELETE_ME", spanText: "will go" }),
    ];
    const targets: LinkTarget[] = [
      makeTarget({ targetId: "KEEP", spanText: "updated" }),
      makeTarget({ targetId: "NEW_ONE", spanText: "fresh" }),
    ];

    const diff = diffWikiReferences(existing, targets);

    expect(diff.toUpdate).toEqual([{ id: "rel-KEEP", spanText: "updated" }]);
    expect(diff.toCreate).toEqual([makeTarget({ targetId: "NEW_ONE", spanText: "fresh" })]);
    expect(diff.toDelete).toEqual(["rel-DELETE_ME"]);
  });

  test("duplicate targets in new set — processWikiContent deduplicates before diffing", () => {
    // processWikiContent deduplicates targets by targetId:predicate before
    // returning, so diffWikiReferences typically receives unique targets.
    // But if duplicates do reach diffWikiReferences, both match the same
    // existing relationship and produce two update entries (last-write-wins
    // at DB level, harmless).
    const existing: ExistingRelationship[] = [
      makeExisting({ targetId: "E1", spanText: "original" }),
    ];
    const targets: LinkTarget[] = [
      makeTarget({ targetId: "E1", spanText: "first mention" }),
      makeTarget({ targetId: "E1", spanText: "second mention" }),
    ];

    const diff = diffWikiReferences(existing, targets);

    expect(diff.toUpdate.length).toBe(2);
    expect(diff.toUpdate[0]!.id).toBe("rel-E1");
    expect(diff.toUpdate[1]!.id).toBe("rel-E1");
    expect(diff.toDelete).toEqual([]);
    expect(diff.toCreate).toEqual([]);
  });

  test("different predicates are treated as different relationships", () => {
    const existing: ExistingRelationship[] = [
      makeExisting({ targetId: "E1", predicate: "references" }),
    ];
    const targets: LinkTarget[] = [
      // Same target but different predicate = new relationship
      makeTarget({ targetId: "E1", predicate: "derived_from" }),
    ];

    const diff = diffWikiReferences(existing, targets);

    // The existing "references" relationship to E1 should be deleted
    // The new "derived_from" relationship to E1 should be created
    expect(diff.toDelete).toEqual(["rel-E1"]);
    expect(diff.toCreate).toEqual([makeTarget({ targetId: "E1", predicate: "derived_from" })]);
    expect(diff.toUpdate).toEqual([]);
  });

  test("large set of changes", () => {
    const existing: ExistingRelationship[] = Array.from({ length: 10 }, (_, i) =>
      makeExisting({ targetId: `E${i}`, id: `rel-${i}`, spanText: `old-${i}` }),
    );

    // Keep first 5, drop last 5, add 3 new
    const targets: LinkTarget[] = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeTarget({ targetId: `E${i}`, spanText: `new-${i}` }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        makeTarget({ targetId: `NEW${i}`, spanText: `fresh-${i}` }),
      ),
    ];

    const diff = diffWikiReferences(existing, targets);

    expect(diff.toUpdate).toHaveLength(5);
    expect(diff.toCreate).toHaveLength(3);
    expect(diff.toDelete).toHaveLength(5);

    // Verify update IDs match the kept ones
    for (let i = 0; i < 5; i++) {
      expect(diff.toUpdate[i]!.id).toBe(`rel-${i}`);
      expect(diff.toUpdate[i]!.spanText).toBe(`new-${i}`);
    }

    // Verify delete IDs match the dropped ones
    for (let i = 5; i < 10; i++) {
      expect(diff.toDelete).toContain(`rel-${i}`);
    }

    // Verify create targets
    for (let i = 0; i < 3; i++) {
      expect(diff.toCreate[i]!.targetId).toBe(`NEW${i}`);
    }
  });
});
