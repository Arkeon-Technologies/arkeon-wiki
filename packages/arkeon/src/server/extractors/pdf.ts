// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * PDF → HTML sidecar handler.
 *
 * Single-stage: spawn the bundled `pdf_extract.py` script via the
 * Python interpreter recorded in the adapters manifest (baked into
 * the official Docker image). The script writes asset files (page
 * renders + embedded figures) into `ctx.assetsDir` and the HTML
 * sidecar to a tmp file inside the staging dir; we read it back
 * after the subprocess exits.
 *
 * Why file-output (not stdout) for the HTML: PyMuPDF's HTML mode
 * emits absolute-positioned <p> elements with inline styles, per
 * glyph in some PDFs. A 500-page OCR'd scan produced >256MB of HTML
 * in testing. Stdout-capture buffers the whole thing in the parent
 * process, which is wasteful and bounds the maximum sidecar size by
 * memory pressure. Writing direct to disk takes that off the table.
 *
 * No escalation chain today — when text extraction is sparse, the
 * page-render PNG is addressable from the sidecar (it lives in
 * .sidecars/<file>.assets/) so callers can read it directly. That's
 * the OCR-by-vision path.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { resolvePythonScript } from "./script-locator.js";
import { runSubprocess } from "./subprocess.js";
import type { FileHandler } from "./types.js";

// 10-minute cap. Realistic worst case: a ~600-page scan at 150 DPI
// takes ~5-6 minutes of pure page-render time on a typical laptop
// (~500-700ms per page render via PyMuPDF.get_pixmap). Beyond this,
// the file is pathological — better to bail to a stub than block the
// watcher forever. Override via ARKEON_WIKI_PDF_EXTRACT_TIMEOUT_MS
// (milliseconds) for very large corpora.
const PDF_EXTRACT_TIMEOUT_MS = (() => {
  const raw = process.env.ARKEON_WIKI_PDF_EXTRACT_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 600_000;
})();

export const pdfHandler: FileHandler = {
  name: "pdf",
  extensions: [".pdf"],
  dependencies: [
    {
      kind: "python_package",
      // Exact pin: the image bakes this version via requirements.lock
      // with --require-hashes at build time. The version here drives
      // the llms.txt summary, so keep it in sync with the lockfile.
      name: "pymupdf",
      versionConstraint: "==1.27.2.3",
      installHint: {
        mac: "ships in the arkeon-wiki Docker image (ghcr.io/arkeon-technologies/arkeon-wiki)",
        linux: "ships in the arkeon-wiki Docker image (ghcr.io/arkeon-technologies/arkeon-wiki)",
        windows: "ships in the arkeon-wiki Docker image (ghcr.io/arkeon-technologies/arkeon-wiki)",
      },
    },
  ],
  async extract(ctx) {
    if (!ctx.adapters.python) {
      throw new Error(
        "adapters manifest has no python entry — PDF extraction requires the arkeon-wiki Docker image (ghcr.io/arkeon-technologies/arkeon-wiki)",
      );
    }
    const script = resolvePythonScript("pdf_extract.py");
    // Write the sidecar HTML to a tmp file inside the staging assets
    // dir; the runner won't keep it (it ignores filenames starting
    // with "_arkeon-") if it ever inspects the dir, and we delete it
    // ourselves after reading. Living inside assetsDir means it gets
    // cleaned up with the rest of the staging tree on any failure.
    const sidecarTmp = join(ctx.assetsDir, "_arkeon-sidecar.html");
    let stderr = "";
    try {
      const result = await runSubprocess({
        cmd: ctx.adapters.python.path,
        args: [script, ctx.absPath, ctx.assetsDir, ctx.assetsRelDir, sidecarTmp],
        signal: ctx.signal,
        timeoutMs: PDF_EXTRACT_TIMEOUT_MS,
      });
      stderr = result.stderr;
    } catch (err) {
      // Best-effort: clean up the tmp HTML if it was partially written.
      try {
        unlinkSync(sidecarTmp);
      } catch {
        /* ignore */
      }
      throw err;
    }

    const html = readFileSync(sidecarTmp, "utf-8");
    try {
      unlinkSync(sidecarTmp);
    } catch {
      /* ignore — runner will nuke the whole staging dir */
    }

    const warnings = stderr
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return {
      html,
      extractedBy: "pymupdf",
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  },
};
