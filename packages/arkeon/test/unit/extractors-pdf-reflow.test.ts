// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for the PyMuPDF reflow logic in pdf_extract.py.
 *
 * The Python script is the boundary the bug lived behind, so the test
 * runs it as a subprocess against a committed fixture and inspects the
 * produced HTML. Gated on a Python interpreter that can `import fitz`
 * — skipped silently when neither $PYTHON nor `python3` on PATH has
 * PyMuPDF installed (e.g., CI runners without the Docker image).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_PKG = resolve(__dirname, "../..");
const SCRIPT = join(
  REPO_PKG,
  "src/server/extractors/python/pdf_extract.py",
);
const FIXTURE = join(REPO_PKG, "test/fixtures/pdf/reflow.pdf");

function findPythonWithFitz(): string | null {
  const candidates = [process.env.PYTHON, "python3", "python"].filter(
    (c): c is string => Boolean(c && c.length > 0),
  );
  for (const cmd of candidates) {
    const probe = spawnSync(cmd, ["-c", "import fitz"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (probe.status === 0) return cmd;
  }
  return null;
}

const PYTHON = findPythonWithFitz();

// Use describe.skipIf so the whole suite is skipped (with a clear name)
// rather than each test individually pretending to pass.
describe.skipIf(!PYTHON)("pdf_extract.py reflow", () => {
  if (!existsSync(FIXTURE)) {
    throw new Error(
      `fixture missing: ${FIXTURE}. Re-generate via test/fixtures/pdf/generate_reflow.py.`,
    );
  }

  function runExtractor(): string {
    const workdir = mkdtempSync(join(tmpdir(), "arkeon-pdf-reflow-"));
    const assetsDir = join(workdir, "assets");
    const outHtml = join(workdir, "out.html");
    execFileSync("mkdir", ["-p", assetsDir]);
    try {
      execFileSync(
        PYTHON as string,
        [SCRIPT, FIXTURE, assetsDir, "assets", outHtml],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      return readFileSync(outHtml, "utf-8");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }

  // Cache: every assertion reads from the same extraction.
  let html = "";
  it("extracts the fixture without error", () => {
    html = runExtractor();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<section data-page="1">');
  });

  it("dehyphenates wrapped words (no orphan hyphen, no mid-word <br>)", () => {
    // The fixture's prose paragraph contains 'comprehensive' which
    // PyMuPDF wraps as 'compre-\nhensive' in block text. The reflow
    // must collapse this into the joined word with no '<br>' and no
    // stray '-'.
    expect(html).toContain("comprehensive");
    expect(html).not.toMatch(/compre-\s*(<br>|<br\s*\/>)?\s*hensive/);
    expect(html).not.toMatch(/[a-z]-<br>[a-z]/);
  });

  it("reflows prose soft-wraps into a single paragraph (no internal <br>)", () => {
    // Pull out the first <p> on page 1 — it's the prose paragraph.
    const m = html.match(
      /<section data-page="1">[\s\S]*?<p>([\s\S]*?)<\/p>/,
    );
    expect(m).not.toBeNull();
    const prose = m![1]!;
    expect(prose).not.toContain("<br>");
    // Sanity: should be a real prose sentence, not a single short word.
    expect(prose.length).toBeGreaterThan(80);
    expect(prose).toContain("comprehensive");
  });

  it("preserves <br> inside lineated blocks (poetry, address)", () => {
    // Poetry stanza from the fixture.
    expect(html).toMatch(/Roses are red,<br>Violets are blue,/);
    // Address block from the fixture.
    expect(html).toMatch(/123 Main Street<br>Cambridge, MA 02139/);
  });

  it("emits the page-render figure alongside the text", () => {
    expect(html).toMatch(
      /<figure data-page-render="true"><img src="assets\/page-1\.png"/,
    );
  });
});

describe.skipIf(!PYTHON)("pdf_extract.py page cap", () => {
  // Generate a tiny 3-page PDF inline so the test doesn't depend on
  // a multi-page committed fixture. The reflow.pdf fixture is 1 page
  // by design — wrong shape for tripping a 1-page cap.
  function makeMultiPagePdf(workdir: string, pages: number): string {
    const pdfPath = join(workdir, "multi.pdf");
    const script = [
      "import fitz",
      `doc = fitz.open()`,
      `for i in range(${pages}):`,
      `    page = doc.new_page()`,
      `    page.insert_text((50, 72), f"page {i+1}")`,
      `doc.save(${JSON.stringify(pdfPath)})`,
      `doc.close()`,
    ].join("\n");
    execFileSync(PYTHON as string, ["-c", script]);
    return pdfPath;
  }

  it("ARKEON_WIKI_PDF_MAX_PAGES=1 bails with exit code 5 before iterating", () => {
    const workdir = mkdtempSync(join(tmpdir(), "arkeon-pdf-cap-"));
    const assetsDir = join(workdir, "assets");
    const outHtml = join(workdir, "out.html");
    execFileSync("mkdir", ["-p", assetsDir]);
    try {
      const pdf = makeMultiPagePdf(workdir, 3);
      const result = spawnSync(
        PYTHON as string,
        [SCRIPT, pdf, assetsDir, "assets", outHtml],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ARKEON_WIKI_PDF_MAX_PAGES: "1" },
        },
      );
      expect(result.status).toBe(5);
      const stderr = result.stderr.toString("utf-8");
      expect(stderr).toContain("1-page cap");
      expect(stderr).toContain("Raise ARKEON_WIKI_PDF_MAX_PAGES");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("ARKEON_WIKI_PDF_MAX_PAGES=0 disables the cap (back to normal extraction)", () => {
    // The runner's "failed_for_binary_hash" tag suppresses retries
    // until content changes, so verifying the disable knob is a
    // common operator workflow: bump cap, delete sidecar, retry.
    // 0 is the documented disable value; assert the extractor runs
    // to completion against a multi-page input even with a tight
    // numeric value that would otherwise trip the guard.
    const workdir = mkdtempSync(join(tmpdir(), "arkeon-pdf-cap-"));
    const assetsDir = join(workdir, "assets");
    const outHtml = join(workdir, "out.html");
    execFileSync("mkdir", ["-p", assetsDir]);
    try {
      const pdf = makeMultiPagePdf(workdir, 3);
      const result = spawnSync(
        PYTHON as string,
        [SCRIPT, pdf, assetsDir, "assets", outHtml],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ARKEON_WIKI_PDF_MAX_PAGES: "0" },
        },
      );
      expect(result.status).toBe(0);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("ARKEON_WIKI_PDF_MAX_PAGES=garbage falls back to the 2000 default", () => {
    // Defensive: an operator passing "high" or some other non-numeric
    // value should get the safe default, not a crash. 2000 > 3 so
    // the 3-page test PDF extracts normally.
    const workdir = mkdtempSync(join(tmpdir(), "arkeon-pdf-cap-"));
    const assetsDir = join(workdir, "assets");
    const outHtml = join(workdir, "out.html");
    execFileSync("mkdir", ["-p", assetsDir]);
    try {
      const pdf = makeMultiPagePdf(workdir, 3);
      const result = spawnSync(
        PYTHON as string,
        [SCRIPT, pdf, assetsDir, "assets", outHtml],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ARKEON_WIKI_PDF_MAX_PAGES: "not-a-number" },
        },
      );
      expect(result.status).toBe(0);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
