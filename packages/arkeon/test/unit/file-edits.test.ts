// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import { safeResolve, validateWikiHtmlDocument } from "../../src/server/lib/file-edits.js";

describe("safeResolve", () => {
  it("resolves a relative path under the watch dir", () => {
    const abs = safeResolve("/tmp/space", "wiki/foo.html");
    expect(abs).toBe("/tmp/space/wiki/foo.html");
  });

  it("rejects absolute paths", () => {
    expect(() => safeResolve("/tmp/space", "/etc/passwd")).toThrow(/absolute/);
  });

  it("rejects paths that escape the watch dir", () => {
    expect(() => safeResolve("/tmp/space", "../escape")).toThrow(/escapes/);
    expect(() => safeResolve("/tmp/space", "wiki/../../escape")).toThrow(/escapes/);
  });

  it("rejects paths containing NUL bytes", () => {
    expect(() => safeResolve("/tmp/space", "foo\0.html")).toThrow(/NUL/);
  });
});

describe("validateWikiHtmlDocument", () => {
  const wellFormed = `<!DOCTYPE html>
<html>
<head>
  <title>Photosynthesis</title>
  <meta name="label" content="Photosynthesis">
</head>
<body>
  <h1>Photosynthesis</h1>
  <p>Plants convert light.</p>
</body>
</html>`;

  it("accepts a well-formed document with <!DOCTYPE>, <title>, and <body>", () => {
    expect(validateWikiHtmlDocument(wellFormed)).toBe(null);
  });

  it("accepts a document that opens with <html> (no DOCTYPE)", () => {
    const html = `<html><head><title>X</title></head><body><h1>X</h1></body></html>`;
    expect(validateWikiHtmlDocument(html)).toBe(null);
  });

  it("accepts uppercase tag names — HTML is case-insensitive", () => {
    const html = `<!DOCTYPE HTML><HTML><HEAD><TITLE>X</TITLE></HEAD><BODY><H1>X</H1></BODY></HTML>`;
    expect(validateWikiHtmlDocument(html)).toBe(null);
  });

  it("tolerates leading whitespace before the wrapper", () => {
    const html = `\n   \t<!DOCTYPE html><html><head><title>X</title></head><body>x</body></html>`;
    expect(validateWikiHtmlDocument(html)).toBe(null);
  });

  it("rejects fragments (no <!DOCTYPE> or <html> wrapper)", () => {
    expect(validateWikiHtmlDocument("<h1>X</h1><p>y</p>")).toEqual({
      reason: "missing-wrapper",
    });
    expect(validateWikiHtmlDocument("<head><title>X</title></head><body>x</body>")).toEqual({
      reason: "missing-wrapper",
    });
  });

  it("rejects a document with no <title>", () => {
    const html = `<!DOCTYPE html><html><head></head><body><h1>X</h1></body></html>`;
    expect(validateWikiHtmlDocument(html)).toEqual({ reason: "missing-title" });
  });

  it("rejects a document whose <title> is whitespace-only", () => {
    const html = `<!DOCTYPE html><html><head><title>   </title></head><body><h1>X</h1></body></html>`;
    expect(validateWikiHtmlDocument(html)).toEqual({ reason: "empty-title" });
  });

  it("rejects a document with no <body>", () => {
    const html = `<!DOCTYPE html><html><head><title>X</title></head></html>`;
    expect(validateWikiHtmlDocument(html)).toEqual({ reason: "missing-body" });
  });
});
