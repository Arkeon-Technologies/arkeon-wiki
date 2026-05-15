// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import {
  safeResolve,
  sanitizeEditedHtmlContent,
  validateWikiHtmlDocument,
} from "../../src/server/lib/file-edits.js";

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
  <meta charset="utf-8">
  <title>Photosynthesis</title>
  <meta name="label" content="Photosynthesis">
</head>
<body>
  <h1>Photosynthesis</h1>
  <p>Plants convert light.</p>
</body>
</html>`;

  it("accepts a well-formed document with <!DOCTYPE>, charset, <title>, and <body>", () => {
    expect(validateWikiHtmlDocument(wellFormed)).toBe(null);
  });

  it("accepts a document that opens with <html> (no DOCTYPE)", () => {
    const html = `<html><head><meta charset="utf-8"><title>X</title></head><body><h1>X</h1></body></html>`;
    expect(validateWikiHtmlDocument(html)).toBe(null);
  });

  it("accepts uppercase tag names — HTML is case-insensitive", () => {
    const html = `<!DOCTYPE HTML><HTML><HEAD><META CHARSET="UTF-8"><TITLE>X</TITLE></HEAD><BODY><H1>X</H1></BODY></HTML>`;
    expect(validateWikiHtmlDocument(html)).toBe(null);
  });

  it("tolerates leading whitespace before the wrapper", () => {
    const html = `\n   \t<!DOCTYPE html><html><head><meta charset="utf-8"><title>X</title></head><body>x</body></html>`;
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

  it("rejects a document with no <meta charset> (mojibake-prevention guard)", () => {
    const html = `<!DOCTYPE html><html><head><title>X</title></head><body>x</body></html>`;
    expect(validateWikiHtmlDocument(html)).toEqual({ reason: "missing-charset" });
  });

  it("accepts any <meta charset> value — existence is what we check, not the encoding", () => {
    // We don't care if someone declares iso-8859-1; that's their footgun.
    // The validator just enforces "you thought about encoding," which is
    // enough to defeat the Latin-1-default browser fallback.
    const html = `<!DOCTYPE html><html><head><meta charset="iso-8859-1"><title>X</title></head><body>x</body></html>`;
    expect(validateWikiHtmlDocument(html)).toBe(null);
  });

  it("rejects a document with no <title>", () => {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><h1>X</h1></body></html>`;
    expect(validateWikiHtmlDocument(html)).toEqual({ reason: "missing-title" });
  });

  it("rejects a document whose <title> is whitespace-only", () => {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>   </title></head><body><h1>X</h1></body></html>`;
    expect(validateWikiHtmlDocument(html)).toEqual({ reason: "empty-title" });
  });

  it("rejects a document with no <body>", () => {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>X</title></head></html>`;
    expect(validateWikiHtmlDocument(html)).toEqual({ reason: "missing-body" });
  });
});

describe("sanitizeEditedHtmlContent", () => {
  it("leaves well-formed HTML unchanged", () => {
    const input = `<p>Hello world</p>`;
    const result = sanitizeEditedHtmlContent(input);
    expect(result.clean).toBe(input);
    expect(result.trimmed).toBeUndefined();
  });

  it("preserves trailing whitespace and newlines", () => {
    const input = `<p>Hello</p>\n  \n`;
    const result = sanitizeEditedHtmlContent(input);
    expect(result.clean).toBe(input);
    expect(result.trimmed).toBeUndefined();
  });

  it("strips the issue #160 leak pattern", () => {
    // Faithful reproduction of the actual leak observed in
    // wiki/why-does-lifelong-learning-feel-like-freedom.html.
    const input = `<p><strong>Lifelong learning is optimization culture.</strong> Body text here.</p>"}]}]၊commentary to=functions.mark_processed  ปมถวายสัตย์  诺果  全民彩票天天ে?}}`;
    const result = sanitizeEditedHtmlContent(input);
    expect(result.clean).toBe(`<p><strong>Lifelong learning is optimization culture.</strong> Body text here.</p>\n`);
    expect(result.trimmed).toContain("commentary to=functions");
    expect(result.trimmed).toContain("诺果");
  });

  it("strips garbage after the last of multiple closing tags", () => {
    const input = `<p>First.</p><p>Second.</p> stray bytes`;
    const result = sanitizeEditedHtmlContent(input);
    expect(result.clean).toBe(`<p>First.</p><p>Second.</p>\n`);
    expect(result.trimmed).toBe(` stray bytes`);
  });

  it("leaves plain text alone when no closing tag exists", () => {
    // A legitimate use case: inserting an HTML comment, a self-closing
    // tag, or plain text. We can't disambiguate from a partial-tag
    // leak, so we choose not to mangle.
    const input = `just some text`;
    const result = sanitizeEditedHtmlContent(input);
    expect(result.clean).toBe(input);
    expect(result.trimmed).toBeUndefined();
  });

  it("leaves self-closing tags alone when no </tag> appears", () => {
    const input = `<br/><img src="x.png"/>`;
    const result = sanitizeEditedHtmlContent(input);
    expect(result.clean).toBe(input);
    expect(result.trimmed).toBeUndefined();
  });

  it("permits closing tags with optional internal whitespace", () => {
    // `</p >` is unusual but valid HTML and shouldn't be misclassified.
    const input = `<p>Hello</p >`;
    const result = sanitizeEditedHtmlContent(input);
    expect(result.clean).toBe(input);
    expect(result.trimmed).toBeUndefined();
  });

  it("strips JSON tool-call closure even without channel routing text", () => {
    // Other leak shapes: just `"}]}` or just `}}` would still be
    // suspicious after a clean `</p>`.
    const input = `<p>Hello world</p>"}]}`;
    const result = sanitizeEditedHtmlContent(input);
    expect(result.clean).toBe(`<p>Hello world</p>\n`);
    expect(result.trimmed).toBe(`"}]}`);
  });
});
