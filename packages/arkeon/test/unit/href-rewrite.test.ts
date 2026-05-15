// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import {
  maybeRewriteHref,
  rewriteHrefsForWrite,
  type RewriteOpts,
} from "../../src/server/lib/href-rewrite.js";

function makeOpts(over: Partial<RewriteOpts> = {}): RewriteOpts {
  const spaces = over.spaces ?? new Map<string, string>([
    ["primary", "/tmp/primary"],
    ["other", "/tmp/work/other"],
  ]);
  return {
    fromPath: over.fromPath ?? "wiki/foo.html",
    spaceName: over.spaceName ?? "primary",
    spaces,
  };
}

describe("maybeRewriteHref — in-space", () => {
  it("rewrites a sibling-article link from a top-level wiki", () => {
    expect(
      maybeRewriteHref("/primary/wiki/bar.html", makeOpts()),
    ).toBe("bar.html");
  });

  it("rewrites a source link from a top-level wiki", () => {
    expect(
      maybeRewriteHref("/primary/sources/notes.txt", makeOpts()),
    ).toBe("../sources/notes.txt");
  });

  it("rewrites a sibling-article link from a nested plan wiki", () => {
    // From wiki/_plans/sources/augustine/ to wiki/: up 3, then descend.
    expect(
      maybeRewriteHref(
        "/primary/wiki/why-grief-is-sweet.html",
        makeOpts({ fromPath: "wiki/_plans/sources/augustine/book-04.html" }),
      ),
    ).toBe("../../../why-grief-is-sweet.html");
  });

  it("rewrites a source link from a nested plan wiki", () => {
    // From wiki/_plans/sources/augustine/ to sources/: up 4 (no shared
    // first segment), then descend.
    expect(
      maybeRewriteHref(
        "/primary/sources/augustine/book-04.md",
        makeOpts({ fromPath: "wiki/_plans/sources/augustine/book-04.html" }),
      ),
    ).toBe("../../../../sources/augustine/book-04.md");
  });

  it("preserves a fragment", () => {
    expect(
      maybeRewriteHref("/primary/wiki/bar.html#section-3", makeOpts()),
    ).toBe("bar.html#section-3");
  });

  it("preserves a query string", () => {
    expect(
      maybeRewriteHref("/primary/wiki/bar.html?v=1", makeOpts()),
    ).toBe("bar.html?v=1");
  });

  it("URL-encodes path segments with spaces and ampersands", () => {
    expect(
      maybeRewriteHref(
        "/primary/sources/Milestones & Schedules/A1/Data.md",
        makeOpts(),
      ),
    ).toBe("../sources/Milestones%20%26%20Schedules/A1/Data.md");
  });

  it("decodes URL-encoded inputs and re-encodes on output", () => {
    expect(
      maybeRewriteHref(
        "/primary/sources/Milestones%20%26%20Schedules/Data.md",
        makeOpts(),
      ),
    ).toBe("../sources/Milestones%20%26%20Schedules/Data.md");
  });

  it("rewrites a URL-encoded space-name prefix", () => {
    // The space name itself happens to be ASCII-safe in our examples,
    // but the rewriter must still tolerate percent-encoded forms.
    expect(
      maybeRewriteHref("/%70rimary/wiki/bar.html", makeOpts()),
    ).toBe("bar.html");
  });
});

describe("maybeRewriteHref — cross-space", () => {
  it("rewrites to a filesystem-relative path crossing watch_dirs", () => {
    // primary watch_dir = /tmp/primary, other watch_dir = /tmp/work/other
    // Article at /tmp/primary/wiki/foo.html → /tmp/primary/wiki/
    // Target at /tmp/work/other/wiki/bar.html
    // Relative = ../../work/other/wiki/bar.html
    expect(
      maybeRewriteHref("/other/wiki/bar.html", makeOpts()),
    ).toBe("../../work/other/wiki/bar.html");
  });

  it("preserves fragments on cross-space links", () => {
    expect(
      maybeRewriteHref("/other/wiki/bar.html#sec", makeOpts()),
    ).toBe("../../work/other/wiki/bar.html#sec");
  });

  it("leaves the href alone when the named space is not registered", () => {
    expect(
      maybeRewriteHref("/nonexistent/wiki/x.html", makeOpts()),
    ).toBeNull();
  });
});

describe("maybeRewriteHref — pass-throughs", () => {
  const opts = makeOpts();

  it("leaves external URLs alone", () => {
    expect(maybeRewriteHref("https://example.com", opts)).toBeNull();
    expect(maybeRewriteHref("mailto:x@y", opts)).toBeNull();
    expect(maybeRewriteHref("tel:+1234", opts)).toBeNull();
  });

  it("leaves protocol-relative URLs alone", () => {
    expect(maybeRewriteHref("//example.com/foo", opts)).toBeNull();
  });

  it("leaves pure fragments alone", () => {
    expect(maybeRewriteHref("#section", opts)).toBeNull();
  });

  it("leaves plain relative paths alone", () => {
    expect(maybeRewriteHref("bar.html", opts)).toBeNull();
    expect(maybeRewriteHref("../sources/x.md", opts)).toBeNull();
    expect(maybeRewriteHref("./foo.html", opts)).toBeNull();
  });

  it("leaves malformed percent encoding alone", () => {
    expect(maybeRewriteHref("/primary/foo%2/bar.html", opts)).toBeNull();
  });

  it("leaves an empty-path slash alone", () => {
    expect(maybeRewriteHref("/", opts)).toBeNull();
  });
});

describe("rewriteHrefsForWrite — full document", () => {
  it("rewrites every <a>, <img>, and <link> in a full HTML doc", () => {
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>X</title>
  <link rel="stylesheet" href="/primary/styles/site.css">
</head>
<body>
  <p>See <a href="/primary/wiki/bar.html">bar</a></p>
  <p><img src="/primary/assets/photo.png" alt=""></p>
  <p><a href="https://example.com">external</a></p>
</body>
</html>`;
    const out = rewriteHrefsForWrite(html, makeOpts());
    expect(out).toContain(`href="../styles/site.css"`);
    expect(out).toContain(`href="bar.html"`);
    expect(out).toContain(`src="../assets/photo.png"`);
    // External link untouched.
    expect(out).toContain(`href="https://example.com"`);
  });

  it("is idempotent: rewritten output passes through unchanged", () => {
    const html = `<a href="/primary/wiki/bar.html">x</a>`;
    const once = rewriteHrefsForWrite(html, makeOpts());
    const twice = rewriteHrefsForWrite(once, makeOpts());
    expect(twice).toBe(once);
  });

  it("hands back the input bytes verbatim when nothing changed", () => {
    // No /-prefixed hrefs to rewrite. The serializer would normalize
    // whitespace; we'd rather not invade snippets that don't need
    // touching.
    const html = `<p><a   href="bar.html">x</a></p>`;
    expect(rewriteHrefsForWrite(html, makeOpts())).toBe(html);
  });

  it("rewrites a fragment (no <html>/<body> wrapper)", () => {
    const frag = `<li><a href="/primary/wiki/q.html">q</a> — gloss.</li>`;
    const out = rewriteHrefsForWrite(frag, makeOpts());
    expect(out).toContain(`href="q.html"`);
  });
});
