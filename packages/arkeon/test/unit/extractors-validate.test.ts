// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildStubSidecar,
  InvalidExtractedHtmlError,
  validateExtractedHtml,
  wrapHtmlDoc,
} from "../../src/server/extractors/validate.js";

describe("validateExtractedHtml", () => {
  it("accepts a minimal well-formed document", () => {
    expect(() =>
      validateExtractedHtml(
        `<!DOCTYPE html><html><body><p>hi</p></body></html>`,
      ),
    ).not.toThrow();
  });

  it("accepts <html> without doctype", () => {
    expect(() =>
      validateExtractedHtml(`<html><body><p>hi</p></body></html>`),
    ).not.toThrow();
  });

  it("accepts case-insensitive prefix and leading whitespace", () => {
    expect(() =>
      validateExtractedHtml(`\n  <!doctype HTML><HTML><body>x</body></HTML>`),
    ).not.toThrow();
  });

  it("rejects empty output", () => {
    expect(() => validateExtractedHtml("")).toThrow(InvalidExtractedHtmlError);
  });

  it("rejects garbage prefix", () => {
    expect(() => validateExtractedHtml("garbage output here")).toThrow(
      InvalidExtractedHtmlError,
    );
  });

  it("rejects missing <body>", () => {
    expect(() =>
      validateExtractedHtml(`<!DOCTYPE html><html><head></head></html>`),
    ).toThrow(InvalidExtractedHtmlError);
  });

  it("rejects an empty <body>", () => {
    expect(() =>
      validateExtractedHtml(`<!DOCTYPE html><html><body>   \n</body></html>`),
    ).toThrow(InvalidExtractedHtmlError);
  });
});

describe("wrapHtmlDoc", () => {
  it("emits a valid document containing the body and title", () => {
    const out = wrapHtmlDoc({
      title: "Hello",
      body: "<p>world</p>",
    });
    expect(out).toContain("<!DOCTYPE html>");
    expect(out).toContain("<title>Hello</title>");
    expect(out).toContain("<p>world</p>");
    expect(() => validateExtractedHtml(out)).not.toThrow();
  });

  it("escapes special characters in the title and meta values", () => {
    const out = wrapHtmlDoc({
      title: `A "quoted" & <special> title`,
      body: "<p>x</p>",
      metaTags: { label: `<crazy>"&` },
    });
    expect(out).toContain("&lt;special&gt;");
    expect(out).toContain("&quot;");
    expect(out).toContain("&amp;");
    expect(() => validateExtractedHtml(out)).not.toThrow();
  });

  it("emits each provided meta tag", () => {
    const out = wrapHtmlDoc({
      title: "x",
      body: "<p>y</p>",
      metaTags: { label: "Label", short_description: "Desc" },
    });
    expect(out).toContain(`<meta name="label" content="Label">`);
    expect(out).toContain(`<meta name="short_description" content="Desc">`);
  });
});

describe("buildStubSidecar", () => {
  it("produces a valid HTML document with the error inline", () => {
    const out = buildStubSidecar({
      binaryRelPath: "sources/papers/paper.pdf",
      handlerName: "pdf",
      error: "timed out after 120000ms",
    });
    expect(out).toContain("<title>sources/papers/paper.pdf");
    expect(out).toContain("Extraction failed");
    expect(out).toContain(`<pre>timed out after 120000ms</pre>`);
    expect(out).toContain(`name="extraction_status" content="failed"`);
    expect(out).toContain(`name="extractor" content="pdf"`);
    expect(() => validateExtractedHtml(out)).not.toThrow();
  });

  it("escapes error content that contains markup-like substrings", () => {
    const out = buildStubSidecar({
      binaryRelPath: "x.pdf",
      handlerName: "pdf",
      error: "<not real html> & 'quotes'",
    });
    expect(out).toContain("&lt;not real html&gt;");
    expect(out).toContain("&amp;");
  });
});
