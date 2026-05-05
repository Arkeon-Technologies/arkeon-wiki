// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import {
  _clearAllEditContextsForTest,
  clearEditContext,
  getEditContext,
  setEditContext,
} from "../../src/server/lib/edit-context.js";

describe("edit-context registry", () => {
  afterEach(() => _clearAllEditContextsForTest());

  it("returns undefined when no context is set", () => {
    expect(getEditContext("space-a", "wiki/x.md")).toBeUndefined();
  });

  it("set/get round-trips a context", () => {
    setEditContext("space-a", "wiki/x.md", {
      role: "ingestor",
      edit_kind: "create",
      note: "first pass",
    });
    const ctx = getEditContext("space-a", "wiki/x.md");
    expect(ctx).toEqual({ role: "ingestor", edit_kind: "create", note: "first pass" });
  });

  it("get does not consume — multiple reads see the same context", () => {
    setEditContext("space-a", "wiki/x.md", { role: "ingestor", edit_kind: "create" });
    expect(getEditContext("space-a", "wiki/x.md")?.role).toBe("ingestor");
    expect(getEditContext("space-a", "wiki/x.md")?.role).toBe("ingestor");
  });

  it("clear removes the context — subsequent reads return undefined", () => {
    setEditContext("space-a", "wiki/x.md", { role: "ingestor", edit_kind: "create" });
    clearEditContext("space-a", "wiki/x.md");
    expect(getEditContext("space-a", "wiki/x.md")).toBeUndefined();
  });

  it("space_id is part of the key — same path in different spaces", () => {
    setEditContext("space-a", "wiki/x.md", { role: "ingestor", edit_kind: "create" });
    setEditContext("space-b", "wiki/x.md", { role: "synthesizer", edit_kind: "replace" });
    expect(getEditContext("space-a", "wiki/x.md")?.role).toBe("ingestor");
    expect(getEditContext("space-b", "wiki/x.md")?.role).toBe("synthesizer");
  });

  it("re-setting the same key overwrites", () => {
    setEditContext("space-a", "wiki/x.md", { role: "ingestor", edit_kind: "create" });
    setEditContext("space-a", "wiki/x.md", { role: "synthesizer", edit_kind: "replace" });
    expect(getEditContext("space-a", "wiki/x.md")?.role).toBe("synthesizer");
  });
});
