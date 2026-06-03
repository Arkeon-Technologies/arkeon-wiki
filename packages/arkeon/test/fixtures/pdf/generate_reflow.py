#!/usr/bin/env python3
# Copyright (c) 2026 Arkeon Technologies, Inc.
# SPDX-License-Identifier: Apache-2.0
"""
Generate the reflow.pdf fixture used by extractors-pdf-reflow.test.ts.

Run once locally with PyMuPDF available, then commit the .pdf:

    python3 generate_reflow.py

Page 1 contains three blocks the reflow logic must handle:
  1. A wide prose paragraph that PyMuPDF wraps in its layout and
     contains an intentionally hyphenated word ("compre-hensive")
     that ends up split across a line boundary.
  2. A short poem stanza — each line a self-contained unit, every
     line ends with terminal punctuation. Should render as <br>.
  3. A mailing address — every line short. Should render as <br>.

The generator places each block in a separate text rectangle so
PyMuPDF emits one distinct "block" per region. We deliberately
choose font sizes / rect widths that force the wrap points we
want to test.
"""
from __future__ import annotations

import os

import fitz

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "reflow.pdf")

PROSE = (
    "This paper presents a comprehensive analysis of distributed "
    "consensus algorithms under network partitions, with particular "
    "attention to liveness guarantees in the presence of byzantine "
    "actors and intermittent connectivity losses."
)

POETRY = (
    "Roses are red,\n"
    "Violets are blue,\n"
    "Sugar is sweet,\n"
    "And so are you."
)

ADDRESS = (
    "Acme Research Lab\n"
    "123 Main Street\n"
    "Cambridge, MA 02139\n"
    "United States"
)


def main() -> int:
    doc = fitz.open()
    page = doc.new_page(width=420, height=600)

    # Narrow column forces the prose to wrap inside fitz, producing
    # multi-line blocks. The rect width is tuned so "comprehensive"
    # is split between two lines.
    page.insert_textbox(
        fitz.Rect(40, 40, 240, 240),
        PROSE,
        fontsize=11,
        align=fitz.TEXT_ALIGN_LEFT,
    )

    # Poetry block — explicit \n inside the text, plus a wider rect
    # so each line stays on one line.
    page.insert_textbox(
        fitz.Rect(40, 260, 380, 360),
        POETRY,
        fontsize=12,
        align=fitz.TEXT_ALIGN_LEFT,
    )

    # Address block — same approach, short lines stay short.
    page.insert_textbox(
        fitz.Rect(40, 380, 380, 480),
        ADDRESS,
        fontsize=12,
        align=fitz.TEXT_ALIGN_LEFT,
    )

    doc.save(OUT)
    doc.close()
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
