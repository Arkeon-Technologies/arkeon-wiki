// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * HTML validation + wrapping helpers for extractor output.
 *
 * `validateExtractedHtml` is the structural gate the runner applies
 * before treating subprocess stdout as a real sidecar. Catches garbage
 * output before it lands on disk as a "sidecar" the editor would later
 * try to read.
 */

export class InvalidExtractedHtmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidExtractedHtmlError";
  }
}

/**
 * Validate that the extractor produced a recognizable HTML document.
 * Mirrors the contract of `wiki/**` files: must start with `<!DOCTYPE>`
 * or `<html>` (case-insensitive, leading whitespace allowed), and the
 * body must contain non-whitespace content.
 *
 * Throws `InvalidExtractedHtmlError` on miss — the runner catches and
 * writes a stub sidecar with the validation failure inline.
 */
export function validateExtractedHtml(html: string): void {
  if (!html || html.length === 0) {
    throw new InvalidExtractedHtmlError("extractor produced empty output");
  }

  const trimmed = html.trimStart();
  const prefix = trimmed.slice(0, 256).toLowerCase();
  if (!prefix.startsWith("<!doctype") && !prefix.startsWith("<html")) {
    throw new InvalidExtractedHtmlError(
      "extractor output must begin with <!DOCTYPE> or <html>",
    );
  }

  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html);
  if (!bodyMatch) {
    throw new InvalidExtractedHtmlError("extractor output missing <body>");
  }
  if (bodyMatch[1]!.replace(/\s+/g, "").length === 0) {
    throw new InvalidExtractedHtmlError("extractor produced an empty <body>");
  }
}

/**
 * Wrap a body fragment in a minimal valid HTML document. Useful for
 * in-process handlers (e.g. mammoth.js) that return raw HTML markup
 * without the envelope.
 */
export function wrapHtmlDoc(opts: {
  title: string;
  body: string;
  metaTags?: Record<string, string>;
}): string {
  const metas = Object.entries(opts.metaTags ?? {})
    .map(([k, v]) => `<meta name="${escapeAttr(k)}" content="${escapeAttr(v)}">`)
    .join("\n  ");
  return `<!DOCTYPE html>
<html>
<head>
  <title>${escapeText(opts.title)}</title>
  ${metas}
</head>
<body>
${opts.body}
</body>
</html>
`;
}

/**
 * Build a "stub" sidecar when extraction fails. Visible to the editor
 * (still a real HTML source it'll read on the queue), with the error
 * inline as a `<pre>` so it's obvious why no extraction happened.
 */
export function buildStubSidecar(opts: {
  binaryRelPath: string;
  handlerName: string;
  error: string;
}): string {
  return wrapHtmlDoc({
    title: `${opts.binaryRelPath} (extraction failed)`,
    metaTags: {
      label: opts.binaryRelPath,
      extraction_status: "failed",
      extractor: opts.handlerName,
    },
    body: `<h1>Extraction failed</h1>
<p>The <code>${escapeText(opts.handlerName)}</code> handler could not extract content from <code>${escapeText(opts.binaryRelPath)}</code>.</p>
<pre>${escapeText(opts.error)}</pre>
`,
  });
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}
