// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Manual real-world PDF extraction smoke test.
 *
 * Downloads a curated corpus of real PDFs (digital papers, government
 * forms, old scanned documents) plus a couple of locally-generated
 * edge cases (image-only "scanned without OCR", encrypted), runs each
 * through the pdfHandler, and writes a markdown report comparing what
 * came out.
 *
 * Run:
 *   ARKEON_WIKI_HOME=/tmp/arkeon-smoke npx tsx scripts/manual-test-real-pdfs.ts
 *
 * Prereq: `arkeon-wiki install-deps` (so the Python venv exists).
 *
 * Cache:
 *   ~/.arkeon-pdf-test/cache/   downloads (deleted only on manual request)
 *   ~/.arkeon-pdf-test/runs/    one dir per run, with sidecar HTML + asset PNGs
 *   ~/.arkeon-pdf-test/REPORT.md     latest report
 *
 * Not committed as automated CI: external URLs rot, IA throws 503,
 * downloads take wall-clock time. This is a manual investigation tool.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { requireAdaptersManifest } from "../src/server/extractors/adapters.js";
import { pdfHandler } from "../src/server/extractors/pdf.js";

interface TestCase {
  name: string;
  description: string;
  expected: string;
  /** Direct URL to download. Omit for locally-generated cases. */
  url?: string;
  /** Generator function for synthetic cases. Receives the cache dir. */
  generate?: (cacheDir: string) => Promise<string>;
  /** Max bytes to allow downloading. Saves bandwidth on a runaway URL. */
  maxBytes?: number;
}

interface TestResult {
  name: string;
  status: "extracted" | "stub" | "download_failed" | "generate_failed";
  bytes: number;
  pageCount: number | null;
  /** Total bytes of text content (estimated from stripped HTML body). */
  textBytes: number;
  assetCount: number;
  embeddedFigures: number;
  pageRenders: number;
  /** True if any page has the "no extractable text" marker. */
  hasNoTextPages: boolean;
  durationMs: number;
  notes: string[];
  /** Path to the produced sidecar HTML (for spot-checking). */
  sidecarPath?: string;
  /** Path to the assets directory. */
  assetsDir?: string;
}

const PYMUPDF_GENERATE_SCRIPT_NO_OCR = (input: string, output: string) => `
import fitz
src = fitz.open(${JSON.stringify(input)})
dst = fitz.open()
for page in src:
    pix = page.get_pixmap(dpi=150)
    new = dst.new_page(width=pix.width, height=pix.height)
    new.insert_image(new.rect, pixmap=pix)
dst.save(${JSON.stringify(output)})
print(f"wrote {len(dst)} pages to {${JSON.stringify(output)}}")
`;

const PYMUPDF_GENERATE_SCRIPT_ENCRYPTED = (input: string, output: string) => `
import fitz
doc = fitz.open(${JSON.stringify(input)})
doc.save(
    ${JSON.stringify(output)},
    encryption=fitz.PDF_ENCRYPT_AES_256,
    user_pw="testpassword",
    owner_pw="ownerpassword",
)
print(f"wrote encrypted PDF to {${JSON.stringify(output)}}")
`;

const PYMUPDF_GENERATE_SCRIPT_NON_LATIN = (output: string) => `
import fitz
doc = fitz.open()
page = doc.new_page(width=400, height=400)
# Mix of scripts. Use Helvetica which is built-in and supports basic chars.
# Real CJK/Arabic PDFs would have embedded fonts.
page.insert_text((50, 80), "Latin: Hello world", fontsize=14)
page.insert_text((50, 120), "Greek: Γειά σου", fontsize=14)
page.insert_text((50, 160), "Cyrillic: Привет", fontsize=14)
page.insert_text((50, 200), "Math: α + β ≤ γ", fontsize=14)
doc.save(${JSON.stringify(output)})
print(f"wrote {output} ({doc.page_count} page)")
`;

const PDF_TEST_ROOT = join(homedir(), ".arkeon-pdf-test");
const CACHE_DIR = join(PDF_TEST_ROOT, "cache");
const RUNS_DIR = join(PDF_TEST_ROOT, "runs");
const REPORT_PATH = join(PDF_TEST_ROOT, "REPORT.md");

function setupDirs(): void {
  for (const dir of [PDF_TEST_ROOT, CACHE_DIR, RUNS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

const CORPUS: TestCase[] = [
  {
    name: "aiayn-paper",
    description: "Attention Is All You Need (arXiv 1706.03762)",
    expected: "digital born, 2-column, figures + equations + tables",
    url: "https://arxiv.org/pdf/1706.03762",
    maxBytes: 5 * 1024 * 1024,
  },
  {
    name: "mistral-7b-paper",
    description: "Mistral 7B paper (arXiv 2310.06825)",
    expected: "digital born, modern ML paper",
    url: "https://arxiv.org/pdf/2310.06825",
    maxBytes: 5 * 1024 * 1024,
  },
  {
    name: "irs-w9-form",
    description: "IRS Form W-9 (government tax form)",
    expected: "digital, fillable AcroForm, multi-column layout",
    url: "https://www.irs.gov/pub/irs-pdf/fw9.pdf",
    maxBytes: 2 * 1024 * 1024,
  },
  {
    name: "adobe-sample",
    description: "Adobe sample explain PDF",
    expected: "digital, simple text + image",
    url: "https://www.adobe.com/support/products/enterprise/knowledgecenter/media/c4611_sample_explain.pdf",
    maxBytes: 2 * 1024 * 1024,
  },
  {
    name: "w3c-dummy",
    description: "W3C minimal test PDF",
    expected: "single-page, text-only, tiny",
    url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    maxBytes: 256 * 1024,
  },
  {
    name: "census-1860",
    description: "1860 US Census (scanned historical document)",
    expected: "scanned, likely OCR text layer from gov digitization",
    url: "https://www2.census.gov/library/publications/decennial/1860/population/1860a-02.pdf",
    maxBytes: 10 * 1024 * 1024,
  },
  {
    name: "govinfo-constitution",
    description: "GovInfo Constitution Annotated (1992 vol)",
    expected: "digital, long, complex legal layout w/ footnotes",
    url: "https://www.govinfo.gov/content/pkg/GPO-CONAN-1992/pdf/GPO-CONAN-1992-7-2.pdf",
    maxBytes: 10 * 1024 * 1024,
  },
  {
    name: "scan-no-ocr",
    description: "Synthetic scanned-no-OCR PDF (image-only)",
    expected: "no extractable text, page renders only, '<p data-note>'",
    generate: async (cache) => {
      // Re-render the AIAYN paper as image-only — simulates a scan
      // without an OCR text layer. Falls through to the no-text path
      // for every page.
      const aiaynPath = join(cache, "aiayn-paper.pdf");
      if (!existsSync(aiaynPath)) {
        throw new Error(
          "scan-no-ocr depends on aiayn-paper download — re-run after that succeeds",
        );
      }
      const out = join(cache, "scan-no-ocr.pdf");
      runPython(PYMUPDF_GENERATE_SCRIPT_NO_OCR(aiaynPath, out));
      return out;
    },
  },
  {
    name: "encrypted",
    description: "Synthetic password-protected PDF",
    expected: "extractor fails with encryption-related error → stub sidecar",
    generate: async (cache) => {
      const w3cPath = join(cache, "w3c-dummy.pdf");
      if (!existsSync(w3cPath)) {
        throw new Error("encrypted depends on w3c-dummy download");
      }
      const out = join(cache, "encrypted.pdf");
      runPython(PYMUPDF_GENERATE_SCRIPT_ENCRYPTED(w3cPath, out));
      return out;
    },
  },
  {
    name: "non-latin",
    description: "Multi-script PDF (Greek/Cyrillic/math)",
    expected: "should extract Unicode text correctly",
    generate: async (cache) => {
      const out = join(cache, "non-latin.pdf");
      runPython(PYMUPDF_GENERATE_SCRIPT_NON_LATIN(out));
      return out;
    },
  },
  {
    name: "wikipedia-zh",
    description: "Chinese Wikipedia article 北京 (Beijing) — real CJK PDF",
    expected: "Han characters extract as Unicode; assets dir produced",
    url: "https://zh.wikipedia.org/api/rest_v1/page/pdf/%E5%8C%97%E4%BA%AC",
    maxBytes: 15 * 1024 * 1024,
  },
  {
    name: "wikipedia-ja",
    description: "Japanese Wikipedia article 東京 (Tokyo) — real CJK PDF",
    expected: "Kanji + Hiragana + Katakana extract as Unicode",
    url: "https://ja.wikipedia.org/api/rest_v1/page/pdf/%E6%9D%B1%E4%BA%AC",
    maxBytes: 15 * 1024 * 1024,
  },
  {
    name: "ams-notices",
    description: "AMS Notices full issue, Feb 2009 — math-heavy journal",
    expected: "math equations may render as inline images or garbled glyphs; long PDF",
    url: "https://www.ams.org/notices/200902/200902FullIssue.pdf",
    maxBytes: 25 * 1024 * 1024,
  },
  {
    name: "ia-origin-of-species",
    description: "Internet Archive: Darwin's Origin of Species (~500 pages, scanned)",
    expected: "very large multi-page scanned PDF; OCR text layer presence varies",
    url: "https://archive.org/download/originofspecies00darwuoft/originofspecies00darwuoft.pdf",
    maxBytes: 40 * 1024 * 1024,
  },
  {
    name: "corrupt-truncated",
    description: "Synthetic truncated PDF (first 4KB of AIAYN)",
    expected: "PyMuPDF should fail to open or iterate; stub sidecar with clear error",
    generate: async (cache) => {
      const src = join(cache, "aiayn-paper.pdf");
      if (!existsSync(src)) {
        throw new Error("corrupt-truncated depends on aiayn-paper download");
      }
      const out = join(cache, "corrupt-truncated.pdf");
      // Read first 4KB of a real PDF — has valid header but no xref/trailer.
      const buf = readFileSync(src).subarray(0, 4096);
      writeFileSync(out, buf);
      return out;
    },
  },
  {
    name: "corrupt-garbage",
    description: "Synthetic non-PDF bytes with .pdf extension",
    expected: "PyMuPDF rejects on open; stub sidecar with clear error",
    generate: async (cache) => {
      const out = join(cache, "corrupt-garbage.pdf");
      writeFileSync(out, "this is not a PDF\nnot even a little bit\n".repeat(100));
      return out;
    },
  },
];

function runPython(script: string): void {
  const adapters = requireAdaptersManifest();
  if (!adapters.python) {
    throw new Error("no python in adapters manifest — run install-deps");
  }
  const result = spawnSync(adapters.python.path, ["-c", script], {
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`python script failed: ${result.stderr}`);
  }
  if (result.stdout) process.stderr.write(`[gen] ${result.stdout.trim()}\n`);
}

async function downloadIfMissing(tc: TestCase): Promise<string> {
  if (!tc.url) throw new Error(`${tc.name} has no url`);
  const target = join(CACHE_DIR, `${tc.name}.pdf`);
  if (existsSync(target) && statSync(target).size > 0) {
    process.stderr.write(`[cache] ${tc.name} (already present)\n`);
    return target;
  }
  process.stderr.write(`[get] ${tc.name} ← ${tc.url}\n`);
  const maxBytes = tc.maxBytes ?? 10 * 1024 * 1024;
  const args = [
    "-fSL", // fail on HTTP errors, silent w/ error, follow redirects
    "--max-time", "45",
    "--max-filesize", String(maxBytes),
    "-A", "Mozilla/5.0 (arkeon-wiki PDF-extractor manual smoke test)",
    "-o", target,
    tc.url,
  ];
  const r = spawnSync("curl", args, { encoding: "utf-8" });
  if (r.status !== 0) {
    if (existsSync(target)) rmSync(target);
    throw new Error(`curl exit ${r.status}: ${r.stderr.trim()}`);
  }
  return target;
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function extractOne(tc: TestCase, pdfPath: string): Promise<TestResult> {
  const runDir = join(RUNS_DIR, tc.name);
  if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });
  const assetsDir = join(runDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const sidecarPath = join(runDir, "sidecar.html");

  const start = Date.now();
  let html = "";
  let extractedBy = "";
  let status: TestResult["status"] = "extracted";
  const notes: string[] = [];

  try {
    const result = await pdfHandler.extract({
      absPath: pdfPath,
      relativePath: `cache/${tc.name}.pdf`,
      spaceName: "manual-test",
      adapters: requireAdaptersManifest(),
      assetsDir,
      assetsRelDir: `${tc.name}.assets`,
      signal: new AbortController().signal,
      log: (level, msg) =>
        process.stderr.write(`[${level}/${tc.name}] ${msg}\n`),
    });
    html = result.html;
    extractedBy = result.extractedBy;
    writeFileSync(sidecarPath, html);
    if (result.warnings && result.warnings.length > 0) {
      notes.push(`${result.warnings.length} warning(s) from extractor`);
      for (const w of result.warnings.slice(0, 3)) notes.push(`  warn: ${w}`);
    }
  } catch (err) {
    status = "stub";
    const msg = err instanceof Error ? err.message : String(err);
    notes.push(`extract threw: ${msg.split("\n")[0]}`);
    html = `<!-- failed: ${msg} -->`;
    writeFileSync(sidecarPath, `<!-- failed: ${msg} -->`);
  }
  const durationMs = Date.now() - start;

  const assetFiles = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
  const embeddedFigures = assetFiles.filter((f) => /-fig-/.test(f)).length;
  const pageRenders = assetFiles.filter((f) => /^page-\d+\.png$/.test(f)).length;

  const stripped = stripHtmlTags(html);
  const textBytes = stripped.length;
  const pageCountMatch = /<meta name="page_count" content="(\d+)">/.exec(html);
  const pageCount = pageCountMatch ? Number(pageCountMatch[1]) : null;
  const hasNoTextPages = /data-note="no-extractable-text"/.test(html);

  return {
    name: tc.name,
    status,
    bytes: statSync(pdfPath).size,
    pageCount,
    textBytes,
    assetCount: assetFiles.length,
    embeddedFigures,
    pageRenders,
    hasNoTextPages,
    durationMs,
    notes,
    sidecarPath,
    assetsDir,
  };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function fmtMs(n: number): string {
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function buildReport(corpus: TestCase[], results: Map<string, TestResult>, downloadErrors: Map<string, string>): string {
  const lines: string[] = [];
  lines.push("# Real-world PDF extraction test report");
  lines.push("");
  lines.push(`_Generated ${new Date().toISOString()}_`);
  lines.push("");
  lines.push("Run via `npx tsx scripts/manual-test-real-pdfs.ts`. Cached PDFs at");
  lines.push("`~/.arkeon-pdf-test/cache/`; per-PDF run output at `~/.arkeon-pdf-test/runs/<name>/`.");
  lines.push("Eyeball-spot-check the sidecar HTMLs + rendered page PNGs to validate quality.");
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push("| Case | Status | Size | Pages | Text | Assets | Figs | Renders | Empty pages? | Time |");
  lines.push("|------|--------|------|-------|------|--------|------|---------|--------------|------|");
  for (const tc of corpus) {
    const r = results.get(tc.name);
    if (!r) {
      const err = downloadErrors.get(tc.name) ?? "(no result)";
      lines.push(`| ${tc.name} | _skip_ | — | — | — | — | — | — | — | — |`);
      lines.push(`| | ↳ ${err} | | | | | | | | |`);
      continue;
    }
    lines.push(
      `| ${r.name} | ${r.status} | ${fmtBytes(r.bytes)} | ${r.pageCount ?? "?"} | ` +
        `${fmtBytes(r.textBytes)} | ${r.assetCount} | ${r.embeddedFigures} | ${r.pageRenders} | ` +
        `${r.hasNoTextPages ? "yes" : "no"} | ${fmtMs(r.durationMs)} |`,
    );
  }
  lines.push("");

  lines.push("## Per-case details");
  lines.push("");
  for (const tc of corpus) {
    lines.push(`### ${tc.name}`);
    lines.push("");
    lines.push(`- **What**: ${tc.description}`);
    lines.push(`- **Expectation**: ${tc.expected}`);
    if (tc.url) lines.push(`- **URL**: ${tc.url}`);
    if (tc.generate) lines.push(`- **Generation**: synthetic (see script)`);
    const r = results.get(tc.name);
    const err = downloadErrors.get(tc.name);
    if (!r) {
      lines.push(`- **Status**: SKIPPED — ${err ?? "no download/generate result"}`);
      lines.push("");
      continue;
    }
    lines.push(`- **Outcome**: ${r.status} in ${fmtMs(r.durationMs)}`);
    lines.push(
      `- **Counts**: ${r.pageCount ?? "?"} pages, ` +
        `~${fmtBytes(r.textBytes)} text, ` +
        `${r.embeddedFigures} embedded figure(s), ` +
        `${r.pageRenders} page render(s)`,
    );
    if (r.hasNoTextPages) {
      lines.push(`- **Empty-text pages**: yes — agent must rely on page renders`);
    }
    if (r.notes.length > 0) {
      lines.push(`- **Notes**:`);
      for (const note of r.notes) lines.push(`  - ${note}`);
    }
    if (r.sidecarPath) {
      lines.push(`- **Sidecar**: \`${r.sidecarPath}\``);
      lines.push(`- **Assets dir**: \`${r.assetsDir}\``);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  setupDirs();
  const results = new Map<string, TestResult>();
  const downloadErrors = new Map<string, string>();

  // Phase 1: download all URLs in parallel-ish (small batches to be polite).
  const urlCases = CORPUS.filter((c) => c.url);
  process.stderr.write(`==> Downloading ${urlCases.length} PDFs\n`);
  for (const tc of urlCases) {
    try {
      await downloadIfMissing(tc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      downloadErrors.set(tc.name, `download failed: ${msg.split("\n")[0]}`);
      process.stderr.write(`[fail] ${tc.name}: ${msg.split("\n")[0]}\n`);
    }
  }

  // Phase 2: generate synthetic cases (may depend on Phase 1 outputs).
  const genCases = CORPUS.filter((c) => c.generate);
  process.stderr.write(`==> Generating ${genCases.length} synthetic PDFs\n`);
  for (const tc of genCases) {
    try {
      const path = await tc.generate!(CACHE_DIR);
      if (!existsSync(path)) throw new Error(`generator did not write ${path}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      downloadErrors.set(tc.name, `generate failed: ${msg.split("\n")[0]}`);
      process.stderr.write(`[fail] ${tc.name}: ${msg.split("\n")[0]}\n`);
    }
  }

  // Phase 3: extract each.
  process.stderr.write(`==> Extracting\n`);
  for (const tc of CORPUS) {
    const path = join(CACHE_DIR, `${tc.name}.pdf`);
    if (!existsSync(path)) {
      continue; // already in downloadErrors
    }
    process.stderr.write(`[run] ${tc.name}\n`);
    try {
      const r = await extractOne(tc, path);
      results.set(tc.name, r);
      process.stderr.write(
        `  ${r.status} pages=${r.pageCount} text=${fmtBytes(r.textBytes)} ` +
          `assets=${r.assetCount} dur=${fmtMs(r.durationMs)}\n`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      downloadErrors.set(tc.name, `extract crashed: ${msg.split("\n")[0]}`);
    }
  }

  // Phase 4: report.
  const report = buildReport(CORPUS, results, downloadErrors);
  writeFileSync(REPORT_PATH, report);
  process.stderr.write(`==> Report: ${REPORT_PATH}\n`);
  process.stdout.write(report);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
