// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2e tests for the binary-ingestion pipeline:
 *
 *   - runExtraction on a real PDF produces a sidecar HTML + asset
 *     directory; both end up indexed by the existing sync path.
 *   - Sidecar carries `extracted_by` tag identifying the handler.
 *   - Re-extraction on the same binary is a no-op when the sidecar's
 *     `extracted_by` is "manual" (user took it over).
 *   - Pure-runner failure → stub sidecar with the error inline.
 *
 * Skips if a Python venv with PyMuPDF isn't available — we don't
 * bundle PyMuPDF as a Node test dep. To run locally:
 *   arkeon-wiki install-deps     # bootstraps ~/.arkeon-wiki/python/
 *   npm run test:e2e             # this file picks up the venv
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/schema/migrate.js";
import { writeAdaptersManifest } from "../../src/server/extractors/adapters.js";
import { runExtraction } from "../../src/server/extractors/runner.js";
import type { AdaptersManifest } from "../../src/server/extractors/types.js";
import { closeDb, createSql, initDb } from "../../src/server/lib/sql.js";
import {
  getEntity,
  setEntityTag,
} from "../../src/server/lib/entities.js";
import { syncFile, type Space } from "../../src/server/lib/sync.js";

/**
 * Probe the user's installed venv for Python + PyMuPDF. Returns the
 * venv python path on success, null if anything is missing. We re-use
 * whatever `arkeon-wiki install-deps` would have produced so dev /
 * CI doesn't need a separate fixture install.
 */
function findVenvPython(): string | null {
  const home = process.env.ARKEON_WIKI_HOME ?? join(process.env.HOME ?? "", ".arkeon-wiki");
  const venvPython = join(home, "python", "bin", "python");
  if (!existsSync(venvPython)) return null;
  const check = spawnSync(venvPython, ["-c", "import fitz"], { encoding: "utf-8" });
  if (check.status !== 0) return null;
  return venvPython;
}

const venvPython = findVenvPython();
const describeIfPython = venvPython ? describe : describe.skip;

let workdir: string;
let savedHome: string | undefined;
const SPACE: Space = { name: "ingest-test", watch_dir: "" };

function buildMinimalPdf(target: string): void {
  // Hand-built minimal PDF: one page, white background, "Hello arkeon"
  // rendered as a text object. Smallest valid PDF that PyMuPDF will
  // parse and produce non-empty text from.
  const lines = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] " +
      "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    "4 0 obj << /Length 44 >>",
    "stream",
    "BT /F1 12 Tf 50 100 Td (Hello arkeon) Tj ET",
    "endstream",
    "endobj",
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "xref",
    "0 6",
    "0000000000 65535 f ",
    "0000000009 00000 n ",
    "0000000054 00000 n ",
    "0000000101 00000 n ",
    "0000000202 00000 n ",
    "0000000295 00000 n ",
    "trailer << /Size 6 /Root 1 0 R >>",
    "startxref",
    "360",
    "%%EOF",
  ];
  writeFileSync(target, lines.join("\n") + "\n");
}

beforeEach(async () => {
  savedHome = process.env.ARKEON_WIKI_HOME;
  workdir = mkdtempSync(join(tmpdir(), "arkeon-ingest-"));
  const dbPath = join(workdir, "arke.db");
  SPACE.watch_dir = join(workdir, "space");

  mkdirSync(SPACE.watch_dir, { recursive: true });
  mkdirSync(join(SPACE.watch_dir, "sources"), { recursive: true });

  await runMigrations({ dbPath });
  initDb(dbPath);

  const sql = createSql();
  await sql`INSERT INTO spaces(name, watch_dir) VALUES(${SPACE.name}, ${SPACE.watch_dir})`;

  // Make `requireAdaptersManifest()` resolve to a manifest pointed at
  // the real venv we found earlier.
  process.env.ARKEON_WIKI_HOME = workdir;
  if (venvPython) {
    const manifest: AdaptersManifest = {
      schema_version: 1,
      python: { path: venvPython, version: "unknown" },
      system_binaries: {},
      python_packages: { pymupdf: { version: "test" } },
      generated_at: new Date().toISOString(),
    };
    writeAdaptersManifest(manifest);
  }
});

afterEach(() => {
  closeDb();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.ARKEON_WIKI_HOME;
  else process.env.ARKEON_WIKI_HOME = savedHome;
});

describeIfPython("runExtraction(pdf) with real PyMuPDF", () => {
  it("produces a sidecar HTML + asset directory for a simple PDF", async () => {
    const pdfPath = join(SPACE.watch_dir, "sources/sample.pdf");
    buildMinimalPdf(pdfPath);
    // Pre-index the binary so the kind='asset' entity exists.
    await syncFile(SPACE, "sources/sample.pdf");

    const outcome = await runExtraction({
      space: SPACE,
      relativePath: "sources/sample.pdf",
    });

    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe("extracted");
    if (outcome!.status !== "extracted") throw new Error("unreachable");
    expect(outcome.extractedBy).toBe("pymupdf");
    expect(outcome.sidecarPath).toBe("sources/sample.pdf.html");
    expect(outcome.assetCount).toBeGreaterThan(0);

    // Sidecar file on disk + asset dir.
    expect(existsSync(join(SPACE.watch_dir, "sources/sample.pdf.html"))).toBe(true);
    const assetsDir = join(SPACE.watch_dir, "sources/sample.pdf.assets");
    expect(existsSync(assetsDir)).toBe(true);
    const assets = readdirSync(assetsDir);
    // At minimum: a page-1.png render.
    expect(assets.some((f) => f === "page-1.png")).toBe(true);

    // Sidecar entity exists, kind='text', tagged extracted_by=pymupdf.
    const sidecarEntity = await getEntity(SPACE.name, "sources/sample.pdf.html");
    expect(sidecarEntity).not.toBeNull();
    expect(sidecarEntity!.kind).toBe("text");
    const tags =
      typeof sidecarEntity!.tags === "string"
        ? JSON.parse(sidecarEntity!.tags)
        : sidecarEntity!.tags;
    expect(tags.extracted_by).toBe("pymupdf");

    // Audit row attributed to "ingest", not "human".
    expect(sidecarEntity!.last_edited_by).toBe("ingest");
  });

  it("skips re-extraction when sidecar is tagged extracted_by=manual", async () => {
    const pdfPath = join(SPACE.watch_dir, "sources/handover.pdf");
    buildMinimalPdf(pdfPath);
    await syncFile(SPACE, "sources/handover.pdf");

    // Pre-write a manual sidecar.
    const manualSidecar = join(SPACE.watch_dir, "sources/handover.pdf.html");
    writeFileSync(
      manualSidecar,
      `<!DOCTYPE html><html><body><p>my hand-curated notes</p></body></html>`,
    );
    await syncFile(SPACE, "sources/handover.pdf.html");
    await setEntityTag(SPACE.name, "sources/handover.pdf.html", "extracted_by", "manual");

    const outcome = await runExtraction({
      space: SPACE,
      relativePath: "sources/handover.pdf",
    });
    expect(outcome!.status).toBe("skipped");
    if (outcome!.status !== "skipped") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/manual/i);

    // No assets directory was created.
    expect(existsSync(join(SPACE.watch_dir, "sources/handover.pdf.assets"))).toBe(false);
    // Manual content survived.
    const sidecarEntity = await getEntity(SPACE.name, "sources/handover.pdf.html");
    expect(sidecarEntity!.source_hash).toBeTruthy();
  });

  it("skips re-extraction when sidecar exists without an extracted_by tag", async () => {
    const pdfPath = join(SPACE.watch_dir, "sources/old.pdf");
    buildMinimalPdf(pdfPath);
    await syncFile(SPACE, "sources/old.pdf");

    // Sidecar pre-existed our extractor — no tag yet.
    writeFileSync(
      join(SPACE.watch_dir, "sources/old.pdf.html"),
      `<!DOCTYPE html><html><body><p>legacy hand-written</p></body></html>`,
    );
    await syncFile(SPACE, "sources/old.pdf.html");

    const outcome = await runExtraction({
      space: SPACE,
      relativePath: "sources/old.pdf",
    });
    expect(outcome!.status).toBe("skipped");
  });
});

describe("runExtraction failure handling (no Python required)", () => {
  it("returns null for non-ingestable extensions", async () => {
    writeFileSync(join(SPACE.watch_dir, "sources/note.txt"), "hi");
    const outcome = await runExtraction({
      space: SPACE,
      relativePath: "sources/note.txt",
    });
    expect(outcome).toBeNull();
  });

  it("writes a stub sidecar when the binary doesn't exist", async () => {
    // No file on disk; runner skips with reason instead of stubbing.
    const outcome = await runExtraction({
      space: SPACE,
      relativePath: "sources/ghost.pdf",
    });
    expect(outcome!.status).toBe("skipped");
    if (outcome!.status !== "skipped") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/disappeared/);
  });
});
