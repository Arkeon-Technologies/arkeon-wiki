// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { applyHeals } from "../../src/server/lib/heal-html.js";

describe("applyHeals", () => {
  it("rewrites a matching anchor's href and reports one change", () => {
    const html = `<a class="wikilink" href="./moved.html">x</a>`;
    const result = applyHeals(html, "bf/inbound.html", [
      { brokenTarget: "bf/moved.html", healedTarget: "bf/sub/moved.html" },
    ]);
    expect(result.changed).toBe(1);
    expect(result.content).toContain(`href="sub/moved.html"`);
    expect(result.content).not.toContain(`href="./moved.html"`);
  });

  it("returns content unchanged when no anchors match", () => {
    const html = `<a class="wikilink" href="./other.html">x</a>`;
    const result = applyHeals(html, "bf/inbound.html", [
      { brokenTarget: "bf/moved.html", healedTarget: "bf/sub/moved.html" },
    ]);
    expect(result.changed).toBe(0);
    expect(result.content).toBe(html);
  });

  it("preserves data-* attrs verbatim while rewriting href", () => {
    // Citation metadata is the whole point of `data-*` on wikilinks;
    // healing the href must not touch it.
    const html = `<a class="wikilink" href="./moved.html" data-quote="On day 3" data-page="7" data-cite-type="evidence">x</a>`;
    const result = applyHeals(html, "bf/inbound.html", [
      { brokenTarget: "bf/moved.html", healedTarget: "bf/sub/moved.html" },
    ]);
    expect(result.changed).toBe(1);
    expect(result.content).toContain(`data-quote="On day 3"`);
    expect(result.content).toContain(`data-page="7"`);
    expect(result.content).toContain(`data-cite-type="evidence"`);
  });

  it("does not touch plain <a> anchors — only `class=\"wikilink\"`", () => {
    // Mirrors extractHtmlLinks's contract: plain anchors aren't part
    // of the link graph and aren't healed.
    const html = `<a href="./moved.html">external</a><a class="wikilink" href="./moved.html">wiki</a>`;
    const result = applyHeals(html, "bf/inbound.html", [
      { brokenTarget: "bf/moved.html", healedTarget: "bf/sub/moved.html" },
    ]);
    expect(result.changed).toBe(1);
    expect(result.content).toContain(`<a href="./moved.html">external</a>`);
    expect(result.content).toContain(`href="sub/moved.html"`);
  });

  it("applies multiple heals in one parse", () => {
    const html =
      `<a class="wikilink" href="./a.html">a</a>` +
      `<a class="wikilink" href="./b.html">b</a>`;
    const result = applyHeals(html, "bf/inbound.html", [
      { brokenTarget: "bf/a.html", healedTarget: "bf/x/a.html" },
      { brokenTarget: "bf/b.html", healedTarget: "bf/y/b.html" },
    ]);
    expect(result.changed).toBe(2);
    expect(result.content).toContain(`href="x/a.html"`);
    expect(result.content).toContain(`href="y/b.html"`);
  });

  it("no-ops on empty heals list (cheap idempotency)", () => {
    const html = `<a class="wikilink" href="./moved.html">x</a>`;
    const result = applyHeals(html, "bf/inbound.html", []);
    expect(result.changed).toBe(0);
    expect(result.content).toBe(html);
  });
});
