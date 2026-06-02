#!/usr/bin/env python3
# Copyright (c) 2026 Arkeon Technologies, Inc.
# SPDX-License-Identifier: Apache-2.0
"""
PDF → HTML sidecar + asset directory extractor.

Usage:
    python pdf_extract.py <input.pdf> <assets_dir> <assets_rel_dir> <output_html_path>

Writes asset files (PNGs/JPGs) into <assets_dir> and writes the HTML
sidecar to <output_html_path>. Argv-only contract — the runner spawns
this script with the binary's path, a pre-created (empty) staging
directory, the basename that staging dir will be renamed to (used in
<img src> paths so the sidecar references the FINAL filenames), and
the final HTML output path.

Writing HTML directly to a file (rather than stdout) avoids buffering
the entire sidecar in the parent process — important for OCR'd
500-page books where PyMuPDF's HTML mode produces hundreds of MB.

Per page:
  1. Emit text-as-HTML via PyMuPDF's structural HTML mode.
  2. Extract every embedded image as a separate asset file referenced
     via <figure data-embedded="true"><img>.
  3. Render the whole page as PNG at 150 DPI as a backup —
     <figure data-page-render="true"><img>. The agent can "look at"
     the rendered page if text extraction was incomplete.

When a page has no extractable text, only the page-render survives and
a `<p data-note="no-extractable-text">` annotates why.

Asset filenames:
  page-N.png          full page render at 150 DPI
  page-N-fig-M.<ext>  embedded figure on page N, ordinal M, original
                      pixel format (PNG with alpha, JPG without)

Stdout: HTML document; stderr: per-page log lines for observability.
Exit codes: 0 success, non-zero on unrecoverable failure (caught by
the TS runner which writes a stub sidecar with stderr inline).
"""

from __future__ import annotations

import html
import os
import sys

try:
    import fitz  # PyMuPDF
except ImportError as exc:  # pragma: no cover — only hit before install-deps
    print(
        "ImportError: pymupdf is not installed in this Python environment. "
        "Run `arkeon-wiki install-deps` to bootstrap the toolchain.",
        file=sys.stderr,
    )
    raise SystemExit(2) from exc


RENDER_DPI = 150


def write(out, *strs: str) -> None:
    for s in strs:
        out.write(s)
        out.write("\n")


def main(argv: list[str]) -> int:
    if len(argv) != 5:
        print(
            "usage: pdf_extract.py <input.pdf> <assets_dir> <assets_rel_dir> <output_html>",
            file=sys.stderr,
        )
        return 2

    input_path = argv[1]
    assets_dir = argv[2]
    assets_basename = argv[3]
    output_html_path = argv[4]

    if not os.path.isfile(input_path):
        print(f"input not found: {input_path}", file=sys.stderr)
        return 2
    if not os.path.isdir(assets_dir):
        print(f"assets_dir not found: {assets_dir}", file=sys.stderr)
        return 2

    binary_basename = os.path.basename(input_path)
    out = open(output_html_path, "w", encoding="utf-8")
    write(
        out,
        "<!DOCTYPE html>",
        "<html>",
        "<head>",
        f"  <title>{html.escape(binary_basename)}</title>",
        f'  <meta name="label" content="{html.escape(binary_basename)}">',
        # `extracted_by` lives in `tags`, not `properties` — the
        # runner sets it via setTag after a successful extraction.
        # Avoid duplicating the same fact across two channels.
        '  <meta name="extractor_kind" content="pdf">',
        "</head>",
        "<body>",
    )

    with fitz.open(input_path) as doc:
        # Early exit on encrypted PDFs — PyMuPDF will let you iterate
        # but get_text / get_images / get_pixmap throw cryptic page-
        # iteration errors. Surface a clean error message instead so
        # the stub sidecar tells the user what's actually wrong.
        if doc.needs_pass:
            print(
                f"PDF is password-protected ({input_path}). "
                "Remove encryption or provide the password before ingestion.",
                file=sys.stderr,
            )
            return 3

        # Detect malformed PDFs that PyMuPDF parses leniently but contain
        # no usable pages (truncated files, junk with a valid header).
        # Without this, we'd write an empty sidecar that passes our HTML
        # validator (the page_count meta tag fills the body) but contains
        # nothing useful — and worse, the sidecar would carry an
        # extracted_by tag that suppresses re-extraction.
        if doc.page_count == 0:
            print(
                f"PDF has zero pages ({input_path}); likely truncated or malformed.",
                file=sys.stderr,
            )
            return 4

        write(out,f'<meta name="page_count" content="{doc.page_count}">')

        for page_index, page in enumerate(doc):
            page_num = page_index + 1
            write(out,f'<section data-page="{page_num}">')

            text = page.get_text().strip()
            has_text = len(text) > 0

            # 1. Text in paragraph form via PyMuPDF's "blocks" mode.
            #
            # We deliberately do NOT use page.get_text("html"): that mode
            # emits per-glyph absolute-positioned <span> tags AND
            # base64-embeds every image inline in the HTML. For OCR'd
            # scanned books that meant ~6MB per page (the embedded page
            # scan base64'd into the text) — a 568-page Origin of
            # Species blew up to 3.5GB of HTML before we caught it.
            # "blocks" mode returns visual blocks with bbox + text, one
            # per paragraph-ish region. We emit a <p> per text block;
            # image blocks are skipped (we extract them separately into
            # the assets dir below, with our own <img src> refs).
            #
            # Tradeoff: we lose pixel-perfect layout (multi-column flow
            # may interleave incorrectly). The agent reads text content
            # either way; agents don't care about CSS positioning.
            if has_text:
                try:
                    blocks = page.get_text("blocks")
                except Exception as exc:  # noqa: BLE001
                    blocks = []
                    print(
                        f"[pdf_extract] page {page_num}: blocks extraction failed: {exc}",
                        file=sys.stderr,
                    )
                for block in blocks:
                    # Tuple format: (x0, y0, x1, y1, text, block_no, block_type)
                    # block_type: 0 = text, 1 = image. Skip image blocks
                    # — we handle them via get_images() below.
                    if len(block) < 7 or block[6] != 0:
                        continue
                    raw_text = block[4]
                    if not isinstance(raw_text, str):
                        continue
                    stripped = raw_text.strip()
                    if not stripped:
                        continue
                    # Preserve in-block line breaks as <br> so soft-
                    # wrapped lines (poetry, addresses, OCR'd lines)
                    # don't collapse into one run-on paragraph.
                    escaped = html.escape(stripped).replace("\n", "<br>")
                    write(out, f"<p>{escaped}</p>")

            # 2. Embedded images / figures.
            #
            # Skip on no-text pages: the embedded image(s) on such a
            # page are almost always either the whole-page scan (which
            # the rendered PNG below captures identically) or part of
            # a vector-only diagram the render also captures. Without
            # this skip, every scanned-PDF page doubles its on-disk
            # footprint with no informational gain (a 52-page Census
            # scan went from ~110MB to ~220MB during testing).
            #
            # On text-rich pages we DO extract figures separately so
            # an agent can fetch a specific figure by name (e.g.
            # "page-3-fig-1.png" matches a Figure 1 reference in the
            # surrounding prose) — BUT we still skip any embedded image
            # whose display rect covers most of the page. That covers
            # OCR'd scanned books: pages have a text layer (from OCR),
            # so `has_text` is True, but the embedded image IS the
            # underlying scan and the page render captures it. Without
            # this dedup, Darwin's Origin of Species (500-page OCR'd
            # scan) produced 1370 assets / 450MB and timed out at 300s.
            if has_text:
                try:
                    images = page.get_images(full=True)
                except Exception as exc:  # noqa: BLE001
                    images = []
                    print(
                        f"[pdf_extract] page {page_num}: get_images failed: {exc}",
                        file=sys.stderr,
                    )

                page_area = page.rect.width * page.rect.height or 1.0
                fig_index = 0
                for img_info in images:
                    xref = img_info[0]
                    try:
                        # Where does this image actually appear on the
                        # page? An image-XRef may be drawn multiple times
                        # (rare); we take the largest rect.
                        try:
                            rects = page.get_image_rects(xref)
                        except Exception:
                            rects = []
                        max_coverage = 0.0
                        for rect in rects:
                            area = rect.width * rect.height
                            coverage = area / page_area
                            if coverage > max_coverage:
                                max_coverage = coverage
                        # 70% of page area → treat as the page scan,
                        # leave it to the page render below.
                        if max_coverage >= 0.7:
                            continue

                        fig_index += 1
                        pix = fitz.Pixmap(doc, xref)
                        if pix.n - pix.alpha >= 4:
                            pix = fitz.Pixmap(fitz.csRGB, pix)
                        has_alpha = pix.alpha == 1
                        ext = "png" if has_alpha else "jpg"
                        asset_name = f"page-{page_num}-fig-{fig_index}.{ext}"
                        pix.save(os.path.join(assets_dir, asset_name))
                        src = f"{assets_basename}/{asset_name}"
                        write(out,
                            f'<figure data-embedded="true">'
                            f'<img src="{html.escape(src, quote=True)}" '
                            f'alt="Page {page_num} figure {fig_index}">'
                            f'</figure>'
                        )
                    except Exception as exc:  # noqa: BLE001
                        print(
                            f"[pdf_extract] page {page_num} fig {fig_index}: extraction failed: {exc}",
                            file=sys.stderr,
                        )

            # 3. Full-page render at RENDER_DPI as the always-available
            # backup. The agent can fetch this if the extracted text is
            # incomplete (tables, math, handwriting, scanned pages).
            try:
                page_pix = page.get_pixmap(dpi=RENDER_DPI)
                page_asset = f"page-{page_num}.png"
                page_pix.save(os.path.join(assets_dir, page_asset))
                src = f"{assets_basename}/{page_asset}"
                write(out,
                    f'<figure data-page-render="true">'
                    f'<img src="{html.escape(src, quote=True)}" '
                    f'alt="Page {page_num} (full render at {RENDER_DPI} DPI)">'
                    f'</figure>'
                )
            except Exception as exc:  # noqa: BLE001
                print(
                    f"[pdf_extract] page {page_num}: page render failed: {exc}",
                    file=sys.stderr,
                )

            if not has_text:
                write(out,
                    '<p data-note="no-extractable-text">'
                    f'Page {page_num} has no extractable text; see rendered image above.'
                    '</p>'
                )

            write(out,"</section>")

    write(out, "</body>")
    write(out, "</html>")
    out.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
