// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Manual substrate-surface smoke test.
 *
 * Builds an isolated corpus (HTML wikis, Markdown, plain anchors, a
 * real PyMuPDF-generated PDF), spawns the daemon against it, then
 * exercises every one of the six commands plus the reader, asserting
 * the response shape and the substrate's hardest-to-test invariants:
 *
 *   - HTML wikilinks: only `<a class="wikilink">` becomes a graph edge.
 *   - `data-*` capture: lands in `links.attrs` JSON.
 *   - Markdown `[[X]]`: shortest-unique-basename resolution.
 *   - PDF → HTML sidecar → kind='text' → FTS5 searchability.
 *   - `linked_from` redlink output: real source paths (regression on
 *     the GROUP_CONCAT separator bug, #179 review P1).
 *   - `kinds` filter: documented array form (regression on
 *     `body.kind` vs `body.kinds` bug, #179 review P1).
 *   - Reader redlink asymmetry: only wikilinks get redlink class, not
 *     plain anchors (regression on rewriteWikilinks scope, #179 review).
 *
 * Run:
 *   npm run build -w packages/arkeon
 *   npx tsx packages/arkeon/scripts/manual-substrate-smoke.ts
 *
 * Optional env:
 *   ARKEON_SMOKE_HOME    isolated state dir   (default /tmp/arkeon-smoke)
 *   ARKEON_SMOKE_CORPUS  isolated watch dir   (default /tmp/arkeon-smoke-corpus)
 *   ARKEON_SMOKE_PORT    daemon port          (default 8765)
 *   ARKEON_SMOKE_KEEP    "1" to keep corpus + state dir after exit
 *
 * Prereq: `ARKEON_WIKI_HOME=<state-dir> arkeon-wiki install-deps` so the
 * Python venv with PyMuPDF exists inside the isolated home. The script
 * runs install-deps automatically if it can't find the venv.
 *
 * NOT a vitest e2e: this drives a real spawned daemon over real HTTP.
 * Exit code 0 on all-green, 1 on any failure.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..");
const DAEMON_BIN = join(PACKAGE_ROOT, "dist", "index.js");

const HOME = process.env.ARKEON_SMOKE_HOME ?? "/tmp/arkeon-smoke";
const CORPUS = process.env.ARKEON_SMOKE_CORPUS ?? "/tmp/arkeon-smoke-corpus";
const PORT = Number(process.env.ARKEON_SMOKE_PORT ?? 8765);
const BASE = `http://127.0.0.1:${PORT}`;
const KEEP = process.env.ARKEON_SMOKE_KEEP === "1";

// ─────────────────────────────────────────────────────────────────────
// Tiny assertion + reporting layer. No vitest dependency.
// ─────────────────────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const results: CheckResult[] = [];

function check(name: string, condition: boolean, detail?: string): void {
  results.push({ name, ok: condition, detail });
  const mark = condition ? "PASS" : "FAIL";
  const tail = detail ? ` — ${detail}` : "";
  console.log(`  [${mark}] ${name}${tail}`);
}

function section(title: string): void {
  console.log("");
  console.log("══════════════════════════════════════════════════════════");
  console.log(`  ${title}`);
  console.log("══════════════════════════════════════════════════════════");
}

// ─────────────────────────────────────────────────────────────────────
// Setup: clean slate, build corpus, ensure venv.
// ─────────────────────────────────────────────────────────────────────

function reset(): void {
  // ALWAYS wipe at start so the smoke is reproducible — stale state
  // from a prior KEEP=1 run otherwise pollutes the assertions
  // (e.g. extra files in the corpus, leftover tags in the DB).
  // KEEP only affects whether we wipe AFTER the run, for inspection.
  rmSync(HOME, { recursive: true, force: true });
  rmSync(CORPUS, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  mkdirSync(join(CORPUS, "iarpa", "sources"), { recursive: true });
  mkdirSync(join(CORPUS, "chartbook"), { recursive: true });
}

function buildCorpus(): void {
  // Wiki A: links to the PDF (with data-* citation metadata), to wiki
  // B (resolvable), and to a missing wiki (redlink). Plus a plain
  // <a> anchor that MUST NOT become a graph edge and MUST NOT be
  // touched by the reader's redlink rewrite.
  writeFileSync(
    join(CORPUS, "iarpa", "article.html"),
    `<!doctype html>
<html><head>
  <title>India: Crop Yield Forecasts</title>
  <meta name="short_description" content="Forecast accuracy for monsoon-season rice.">
  <meta name="region" content="South Asia">
</head><body>
  <h1>India: Crop Yield Forecasts</h1>
  <p>Field study source: <a class="wikilink" href="./sources/paper.pdf"
       data-quote="Late onset shifted planting by 11 days"
       data-page="3" data-cite-type="evidence">paper</a>.</p>
  <p>Related: <a class="wikilink" href="./photosynthesis.html">photosynthesis baseline</a>.</p>
  <p>External read: <a href="https://example.com/x">a plain external link</a>.</p>
  <p>Future article: <a class="wikilink" href="./drought-index.html">drought index</a>.</p>
</body></html>`,
  );

  // Wiki B: links back to A — creates a backlink cycle.
  writeFileSync(
    join(CORPUS, "iarpa", "photosynthesis.html"),
    `<!doctype html>
<html><head>
  <title>Photosynthesis</title>
  <meta name="short_description" content="Carbon fixation baseline used by the yield model.">
</head><body>
  <h1>Photosynthesis</h1>
  <p>The yield model treats <a class="wikilink" href="./article.html">crop yield forecasting</a>
     as a function of light-use efficiency and stomatal conductance.</p>
</body></html>`,
  );

  // Markdown: shortest-unique-basename match against article.html +
  // photosynthesis.html, plus an alias and a missing target.
  writeFileSync(
    join(CORPUS, "iarpa", "sources", "notes.md"),
    `# Notes on monsoon timing

These notes feed [[article]] (the India yield forecast wiki) and the
upcoming [[drought-index]] writeup.

Cross-cutting reference: [[photosynthesis|the carbon-fixation baseline]].

The word "monsoon" and "stomatal" should be FTS5-searchable.
`,
  );

  // Outside iarpa/, tests folder isolation in /query.
  writeFileSync(
    join(CORPUS, "chartbook", "index.html"),
    `<!doctype html><html><head><title>Chartbook</title></head>
<body><p>Folder isolation test — should not appear in folder=iarpa.</p></body></html>`,
  );

  generatePdf(join(CORPUS, "iarpa", "sources", "paper.pdf"));
}

function generatePdf(outputPath: string): void {
  const venvPython = join(HOME, "python", "bin", "python");
  if (!existsSync(venvPython)) {
    console.log(`[smoke] python venv missing; running install-deps into ${HOME}`);
    const r = spawnSync(
      process.execPath,
      [DAEMON_BIN, "install-deps"],
      { env: { ...process.env, ARKEON_WIKI_HOME: HOME }, stdio: "inherit" },
    );
    if (r.status !== 0) {
      throw new Error(`install-deps failed (exit ${r.status})`);
    }
  }
  const py = `
import fitz
doc = fitz.open()
p1 = doc.new_page()
p1.insert_text((72, 90), "India Monsoon Field Study (2025)", fontsize=14)
p1.insert_text((72, 130), "Page 1 — Methods", fontsize=11)
p1.insert_text((72, 160), "Plots across 12 districts, weekly NDVI sampling.", fontsize=10)
p2 = doc.new_page()
p2.insert_text((72, 90), "Page 2 — Results", fontsize=11)
p2.insert_text((72, 130), "Stomatal conductance dropped 18 percent in dry weeks.", fontsize=10)
p3 = doc.new_page()
p3.insert_text((72, 90), "Page 3 — Discussion", fontsize=11)
p3.insert_text((72, 130), "Late onset shifted planting by 11 days on average.", fontsize=10)
p3.insert_text((72, 160), "Yields fell 7 percent versus 5-year baseline.", fontsize=10)
doc.save(${JSON.stringify(outputPath)})
doc.close()
`;
  const r = spawnSync(venvPython, ["-c", py], { stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`pdf generation failed (exit ${r.status})`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Daemon lifecycle.
// ─────────────────────────────────────────────────────────────────────

async function spawnDaemon(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [DAEMON_BIN, "start", "--name", "smoke", "--port", String(PORT), "--watch-dir", CORPUS],
    {
      env: { ...process.env, ARKEON_WIKI_HOME: HOME },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  child.on("error", (err) => console.error("[smoke] daemon spawn error:", err));
  return child;
}

async function waitReady(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* daemon not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`daemon did not become ready within ${timeoutMs}ms`);
}

async function waitForArtifact(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await postJson("/query", { path_substring: path });
    // path_substring isn't a real filter, but listing should include
    // the artifact regardless; check via /tags instead which returns
    // 404 when the artifact doesn't exist yet.
    try {
      const r = await fetch(`${BASE}/tags?path=${encodeURIComponent(path)}`);
      if (r.ok) return;
    } catch {
      /* keep polling */
    }
    void body;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`artifact ${path} never appeared within ${timeoutMs}ms`);
}

// ─────────────────────────────────────────────────────────────────────
// HTTP helpers.
// ─────────────────────────────────────────────────────────────────────

async function postJson(path: string, body: unknown): Promise<any> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await safeJson(r) };
}

async function getJson(path: string): Promise<any> {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, body: await safeJson(r) };
}

async function getText(path: string): Promise<{ status: number; body: string }> {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, body: await r.text() };
}

async function safeJson(r: Response): Promise<any> {
  try {
    return await r.json();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// The six commands + reader.
// ─────────────────────────────────────────────────────────────────────

async function runChecks(): Promise<void> {
  section("POST /query — listing + folder + kinds + text (FTS5)");
  {
    const r = await postJson("/query", {});
    check("POST /query (no filter) returns 200", r.status === 200);
    const paths: string[] = r.body.artifacts.map((a: any) => a.path);
    check(
      "indexes the 5 corpus files + the PDF sidecar + 3 page asset PNGs (9 total)",
      r.body.total === 9,
      `total=${r.body.total}, sample=${paths.slice(0, 3).join(", ")}`,
    );
    check(
      "PDF sidecar lands at .sidecars/iarpa/sources/paper.pdf.html",
      paths.includes(".sidecars/iarpa/sources/paper.pdf.html"),
    );
  }

  {
    const r = await postJson("/query", { folder: "iarpa", kinds: ["text"] });
    const paths: string[] = r.body.artifacts.map((a: any) => a.path);
    check(
      "POST /query folder=iarpa kinds=text excludes chartbook + assets",
      r.body.total === 3 &&
        paths.includes("iarpa/article.html") &&
        paths.includes("iarpa/photosynthesis.html") &&
        paths.includes("iarpa/sources/notes.md") &&
        !paths.some((p) => p.startsWith("chartbook/")) &&
        !paths.some((p) => p.endsWith(".png")),
      `total=${r.body.total}, paths=${paths.join(", ")}`,
    );
  }

  {
    const r = await postJson("/query", { kinds: ["bogus"] });
    check(
      "POST /query rejects unknown kinds with 400 (regression on parseKinds validation)",
      r.status === 400,
      `status=${r.status}`,
    );
  }

  {
    const r = await postJson("/query", { text: "stomatal" });
    const paths: string[] = r.body.artifacts.map((a: any) => a.path);
    check(
      "POST /query text=stomatal hits the PDF sidecar (FTS5 over extracted text)",
      paths.includes(".sidecars/iarpa/sources/paper.pdf.html"),
      `paths=${paths.join(", ")}`,
    );
  }

  {
    // Round-2 regression: <meta> tags must round-trip into artifact.properties.
    // The hydration / parseJsonObject double-parse silently zeroed them out
    // in the pre-pt4 build.
    const r = await postJson("/query", {});
    const article = r.body.artifacts.find(
      (a: any) => a.path === "iarpa/article.html",
    );
    check(
      "artifact.properties carries <meta> tags from the source HTML",
      article?.properties?.short_description === "Forecast accuracy for monsoon-season rice." &&
        article?.properties?.region === "South Asia",
      JSON.stringify(article?.properties),
    );
  }

  section("POST /tag + GET /tags + /query not_tag — worker-queue pattern");
  {
    const t1 = await postJson("/tag", {
      path: "iarpa/article.html",
      key: "processed-by",
      value: "editor",
    });
    check("POST /tag returns {ok:true}", t1.status === 200 && t1.body.ok === true);

    const t2 = await getJson("/tags?path=iarpa/article.html");
    check(
      "GET /tags returns the tag we just set",
      t2.status === 200 && t2.body.tags["processed-by"] === "editor",
      JSON.stringify(t2.body.tags),
    );

    const q = await postJson("/query", {
      folder: "iarpa",
      kinds: ["text"],
      not_tag: ["processed-by:editor"],
    });
    const paths: string[] = q.body.artifacts.map((a: any) => a.path);
    check(
      "POST /query not_tag=processed-by:editor excludes the tagged article",
      !paths.includes("iarpa/article.html") &&
        paths.includes("iarpa/photosynthesis.html"),
      `paths=${paths.join(", ")}`,
    );
  }

  section("POST /untag — round trip + idempotency");
  {
    const u = await postJson("/untag", { path: "iarpa/article.html", key: "processed-by" });
    check(
      "POST /untag on real tag: {ok:true, existed:true}",
      u.status === 200 && u.body.ok === true && u.body.existed === true,
      JSON.stringify(u.body),
    );
    const u2 = await postJson("/untag", { path: "iarpa/article.html", key: "processed-by" });
    check(
      "POST /untag idempotent — same call returns {ok:true, existed:false}",
      u2.status === 200 && u2.body.ok === true && u2.body.existed === false,
      JSON.stringify(u2.body),
    );
  }

  section("GET /backlinks — inbound graph edges with data-* attrs");
  {
    const r = await getJson(
      `/backlinks?path=${encodeURIComponent("iarpa/article.html")}`,
    );
    const sources: string[] = r.body.backlinks.map((b: any) => b.source_path);
    check(
      "/backlinks for article.html surfaces photosynthesis.html",
      sources.includes("iarpa/photosynthesis.html"),
      sources.join(", "),
    );
  }

  {
    const r = await getJson(
      `/backlinks?path=${encodeURIComponent("iarpa/sources/paper.pdf")}`,
    );
    const article = r.body.backlinks.find(
      (b: any) => b.source_path === "iarpa/article.html",
    );
    check(
      "PDF backlink carries data-* attributes (quote, page, cite-type)",
      article?.attrs?.quote?.startsWith("Late onset") &&
        article.attrs.page === "3" &&
        article.attrs["cite-type"] === "evidence",
      JSON.stringify(article?.attrs),
    );
  }

  section("GET /redlinks — work queue with INTACT linked_from paths");
  {
    const r = await getJson("/redlinks");
    const droughtIndex = r.body.redlinks.find(
      (rl: any) => rl.target_path === "iarpa/drought-index.html",
    );
    check(
      "redlink target_path = iarpa/drought-index.html (HTML wikilink to missing file)",
      droughtIndex != null,
    );
    check(
      "linked_from is a real source path, NOT character-shredded (regression on GROUP_CONCAT bug)",
      droughtIndex?.linked_from?.[0] === "iarpa/article.html" &&
        droughtIndex.linked_from.every((s: string) => s.length > 1),
      JSON.stringify(droughtIndex?.linked_from),
    );

    const droughtMd = r.body.redlinks.find(
      (rl: any) => rl.target_path === "drought-index",
    );
    check(
      "MD [[drought-index]] surfaces as a redlink (basename verbatim)",
      droughtMd != null,
    );
  }

  section("Reader — directory listing + wikilink rewrite + redlink asymmetry");
  {
    const r = await getText("/");
    check(
      "GET / returns HTML directory listing of the watched root",
      r.status === 200 && r.body.includes("iarpa/") && r.body.includes("chartbook/"),
    );

    const r2 = await getText("/iarpa/article.html");
    check(
      "wikilink to existing target keeps class='wikilink' (no redlink)",
      /class="wikilink" href="\.\/photosynthesis\.html"/.test(r2.body),
    );
    check(
      "wikilink to missing target (drought-index.html) gains 'redlink' class",
      /class="wikilink redlink" href="\.\/drought-index\.html"/.test(r2.body),
    );
    check(
      "plain anchor (example.com) is NOT rewritten — no redlink class added",
      /<a href="https:\/\/example\.com\/x">/.test(r2.body),
      "plain external anchor stays untouched",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Driver.
// ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[smoke] state dir: ${HOME}`);
  console.log(`[smoke] corpus:    ${CORPUS}`);
  console.log(`[smoke] port:      ${PORT}`);
  console.log(`[smoke] keep:      ${KEEP ? "yes" : "no"}`);

  reset();
  buildCorpus();

  const daemon = await spawnDaemon();
  let exitCode = 0;
  try {
    await waitReady();
    // Initial reconcile + PDF extraction is async; the sidecar shows
    // up after extraction completes. Wait for it explicitly so the
    // FTS5 + sidecar checks don't race.
    await waitForArtifact(".sidecars/iarpa/sources/paper.pdf.html");
    await runChecks();
  } catch (err) {
    console.error("[smoke] driver failure:", err);
    exitCode = 1;
  } finally {
    daemon.kill("SIGTERM");
    // Best-effort wait for it to exit cleanly.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 2_000);
      daemon.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  section("Summary");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`  ${passed}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log("");
    for (const f of failed) {
      console.log(`  FAIL: ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    }
    exitCode = 1;
  }
  if (!KEEP) {
    console.log("");
    console.log(`[smoke] cleanup: rm -rf ${HOME} ${CORPUS}`);
    rmSync(HOME, { recursive: true, force: true });
    rmSync(CORPUS, { recursive: true, force: true });
  } else {
    console.log("");
    console.log(`[smoke] keeping state at ${HOME} and corpus at ${CORPUS}`);
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error("[smoke] fatal:", err);
  process.exit(1);
});
