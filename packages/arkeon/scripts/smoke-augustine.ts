#!/usr/bin/env tsx
// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-corpus smoke test driver for the ingestor agent.
 *
 * Pulls Augustine's Confessions (Pusey translation, Project Gutenberg
 * eBook 3296), slices it into the canonical 13 books, and drops one
 * book at a time into a persistent watch dir. Polls agent_runs until
 * each ingest finishes and prints a structured report between books
 * so the operator can read the generated wikis before continuing.
 *
 * Pre-flight (the script does not start anything itself):
 *   1. arkeon-wiki up --name confessions          (run once)
 *   2. cd <smoke-dir> && arkeon-wiki init         (run once per dir)
 *   3. Ensure OPENAI_API_KEY is in ~/.arkeon-wiki/.env
 *
 * Then:
 *   npx tsx packages/arkeon/scripts/smoke-augustine.ts --books 1
 *   npx tsx packages/arkeon/scripts/smoke-augustine.ts --books 1-3
 *   npx tsx packages/arkeon/scripts/smoke-augustine.ts --books 8-9   (conversion)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";

import Database from "better-sqlite3";
import yaml from "js-yaml";

// ── Args ───────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    dir: {
      type: "string",
      default: join(homedir(), "Working/arkeon/smoke-augustine"),
    },
    instance: { type: "string", default: "confessions" },
    books: { type: "string", default: "1" },
    timeout: { type: "string", default: "900" }, // 15 min per book
    "no-pause": { type: "boolean", default: false },
  },
});

const SMOKE_DIR = resolve(args.dir!);
const INSTANCE = args.instance!;
const TIMEOUT_MS = Number(args.timeout) * 1000;
const PAUSE = !args["no-pause"];

const ROMAN = [
  "I", "II", "III", "IV", "V", "VI", "VII", "VIII",
  "IX", "X", "XI", "XII", "XIII",
] as const;

function parseRange(s: string): number[] {
  const out = new Set<number>();
  for (const part of s.split(",")) {
    const m = part.trim();
    if (m.includes("-")) {
      const [a, b] = m.split("-").map((n) => parseInt(n, 10));
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      out.add(parseInt(m, 10));
    }
  }
  const arr = [...out].sort((a, b) => a - b);
  for (const n of arr) {
    if (!Number.isInteger(n) || n < 1 || n > 13) {
      throw new Error(`Book ${n} out of range (1-13)`);
    }
  }
  return arr;
}

const BOOK_RANGE = parseRange(args.books!);

// ── Gutenberg fetch + slice ────────────────────────────────────────

const GUTENBERG_URL = "https://www.gutenberg.org/cache/epub/3296/pg3296.txt";
const CACHE = join(tmpdir(), "arkeon-confessions-3296.txt");

async function fetchConfessions(): Promise<string> {
  if (existsSync(CACHE)) return readFileSync(CACHE, "utf-8");
  console.log(`Fetching Confessions from ${GUTENBERG_URL} …`);
  const res = await fetch(GUTENBERG_URL);
  if (!res.ok) {
    throw new Error(`Gutenberg fetch failed: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  writeFileSync(CACHE, text, "utf-8");
  return text;
}

function sliceBook(book: string, n: number): string {
  const here = new RegExp(`^BOOK ${ROMAN[n - 1]}$`, "m");
  const start = book.search(here);
  if (start < 0) throw new Error(`Book ${n} (${ROMAN[n - 1]}) not found`);

  const after = ROMAN[n]
    ? book.slice(start + 1).search(new RegExp(`^BOOK ${ROMAN[n]}$`, "m"))
    : -1;
  const end =
    after >= 0
      ? start + 1 + after
      : (() => {
          const tail = book.indexOf("*** END OF THE PROJECT GUTENBERG", start);
          return tail > 0 ? tail : book.length;
        })();

  // Drop the "BOOK <ROMAN>\n" header line itself.
  const headerEnd = book.indexOf("\n", start);
  return book.slice(headerEnd + 1, end).trim();
}

// ── Pre-flight checks ──────────────────────────────────────────────

function preflight(): { dbPath: string } {
  const dbPath = join(homedir(), ".arkeon-wiki", INSTANCE, "data", "arke.db");
  const pidPath = join(homedir(), ".arkeon-wiki", INSTANCE, "arkeon.pid");
  const statePath = join(SMOKE_DIR, ".arkeon", "state.json");

  if (!existsSync(pidPath)) {
    console.error(
      [
        `No daemon found for instance '${INSTANCE}'.`,
        ``,
        `From the ingestor-phases worktree, run:`,
        `  arkeon-wiki up --name ${INSTANCE}`,
      ].join("\n"),
    );
    process.exit(1);
  }
  if (!existsSync(dbPath)) {
    console.error(`Daemon pidfile present but DB not found at ${dbPath}.`);
    process.exit(1);
  }
  if (!existsSync(statePath)) {
    console.error(
      [
        `Smoke dir is not bound to a space.`,
        ``,
        `Run:`,
        `  cd ${SMOKE_DIR} && arkeon-wiki init`,
      ].join("\n"),
    );
    process.exit(1);
  }
  return { dbPath };
}

function setupSmokeDir(): void {
  mkdirSync(join(SMOKE_DIR, "sources"), { recursive: true });
  mkdirSync(join(SMOKE_DIR, "wiki"), { recursive: true });
  mkdirSync(join(SMOKE_DIR, ".arkeon"), { recursive: true });

  const agentsPath = join(SMOKE_DIR, ".arkeon", "agents.yaml");
  if (!existsSync(agentsPath)) {
    const yamlText = yaml.dump(
      {
        defaults: {
          provider: "openai",
          model: "gpt-5.4",
        },
        roles: {
          ingestor: {
            phase_models: {
              gather: "gpt-5.4-mini",
              write: "gpt-5.4",
            },
          },
        },
      },
      { schema: yaml.JSON_SCHEMA, sortKeys: false },
    );
    writeFileSync(agentsPath, yamlText);
    console.log(`Wrote ${agentsPath}`);
  }
}

// ── DB polling ─────────────────────────────────────────────────────

function openDbReadOnly(dbPath: string): Database.Database {
  // The daemon owns writes; we only read. WAL allows concurrent readers.
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

interface AgentRunRow {
  status: "completed" | "failed";
  error: string | null;
}

async function waitForCompletion(
  db: Database.Database,
  sourceRelative: string,
  timeoutMs: number,
): Promise<{ status: "completed" | "failed" | "timeout"; error: string | null }> {
  const stmt = db.prepare(
    "SELECT status, error FROM agent_runs WHERE role = 'ingestor' AND idempotency_key = ?",
  );
  const deadline = Date.now() + timeoutMs;
  let lastSpinnerTs = 0;
  while (Date.now() < deadline) {
    const row = stmt.get(sourceRelative) as AgentRunRow | undefined;
    if (row) {
      process.stdout.write("\r");
      return { status: row.status, error: row.error };
    }
    // Lightweight progress dot every 10s so the operator knows we're alive.
    const now = Date.now();
    if (now - lastSpinnerTs > 10_000) {
      process.stdout.write(".");
      lastSpinnerTs = now;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  process.stdout.write("\n");
  return { status: "timeout", error: null };
}

// ── Wiki disk scan + report ────────────────────────────────────────

interface WikiInfo {
  path: string;          // absolute
  relPath: string;       // relative to SMOKE_DIR
  slug: string;
  subjectType: string;
  label: string;
  shortDescription: string | null;
  outgoingLinks: string[]; // raw relative link paths from body
  body: string;
}

function scanWikis(): WikiInfo[] {
  const wikiRoot = join(SMOKE_DIR, "wiki");
  const out: WikiInfo[] = [];
  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".md")) {
        const content = readFileSync(p, "utf-8");
        const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        if (!m) continue;
        let fm: Record<string, unknown> = {};
        try {
          fm = (yaml.load(m[1], { schema: yaml.JSON_SCHEMA }) ?? {}) as Record<string, unknown>;
        } catch {
          // ignore parse failures — count as malformed
        }
        const body = m[2] ?? "";
        const links: string[] = [];
        for (const lm of body.matchAll(/\]\(([^)]+)\)/g)) links.push(lm[1]);
        const rel = relative(SMOKE_DIR, p);
        // wiki/<subject_type>/<slug>.md
        const segs = rel.split("/");
        const subjectType =
          (typeof fm.subject_type === "string" && fm.subject_type) ||
          segs[1] ||
          "(unknown)";
        const slug = (segs[segs.length - 1] ?? "").replace(/\.md$/, "");
        out.push({
          path: p,
          relPath: rel,
          slug,
          subjectType,
          label: (typeof fm.label === "string" && fm.label) || "(no label)",
          shortDescription:
            typeof fm.short_description === "string" && fm.short_description.trim()
              ? fm.short_description.trim()
              : null,
          outgoingLinks: links,
          body,
        });
      }
    }
  }
  walk(wikiRoot);
  return out;
}

interface Report {
  total: number;
  bySubjectType: Map<string, WikiInfo[]>;
  shortDescCoverage: { with: number; without: number };
  wikiToWikiLinks: number;
  danglingLinks: { from: string; href: string }[];
  crossTypeDuplicates: { slug: string; types: string[] }[];
  sourceMentions: Map<string, number>; // source rel path -> # wikis citing it
}

function buildReport(wikis: WikiInfo[], allSourceFiles: string[]): Report {
  const bySubjectType = new Map<string, WikiInfo[]>();
  for (const w of wikis) {
    const arr = bySubjectType.get(w.subjectType) ?? [];
    arr.push(w);
    bySubjectType.set(w.subjectType, arr);
  }

  let withDesc = 0;
  let withoutDesc = 0;
  for (const w of wikis) {
    if (w.shortDescription) withDesc++;
    else withoutDesc++;
  }

  // Resolve every outgoing link to its target file. Two link styles:
  //   - workspace-rooted: leading "/" is relative to SMOKE_DIR
  //   - dot-relative:     resolved against the wiki's own directory
  let wikiToWikiLinks = 0;
  const dangling: Report["danglingLinks"] = [];
  for (const w of wikis) {
    for (const href of w.outgoingLinks) {
      // Skip non-file URLs (http://, mailto:, etc.).
      if (/^[a-z]+:/i.test(href)) continue;
      const target = href.startsWith("/")
        ? resolve(SMOKE_DIR, href.slice(1))
        : resolve(w.path.substring(0, w.path.lastIndexOf("/")), href);
      const targetRel = relative(SMOKE_DIR, target);
      const exists = existsSync(target);
      const isWikiTarget = targetRel.startsWith("wiki/") && targetRel.endsWith(".md");
      if (isWikiTarget && exists) {
        wikiToWikiLinks++;
      } else if (!exists) {
        dangling.push({ from: w.relPath, href });
      }
    }
  }

  // Cross-type slug duplicates.
  const slugTypes = new Map<string, Set<string>>();
  for (const w of wikis) {
    const set = slugTypes.get(w.slug) ?? new Set<string>();
    set.add(w.subjectType);
    slugTypes.set(w.slug, set);
  }
  const crossTypeDuplicates: Report["crossTypeDuplicates"] = [];
  for (const [slug, set] of slugTypes) {
    if (set.size > 1) crossTypeDuplicates.push({ slug, types: [...set].sort() });
  }

  // Source-mention counts: for each source file in sources/, count the
  // wikis that include that path in their body.
  const sourceMentions = new Map<string, number>();
  for (const src of allSourceFiles) {
    let count = 0;
    for (const w of wikis) {
      if (w.body.includes(src)) count++;
    }
    sourceMentions.set(src, count);
  }

  return {
    total: wikis.length,
    bySubjectType,
    shortDescCoverage: { with: withDesc, without: withoutDesc },
    wikiToWikiLinks,
    danglingLinks: dangling,
    crossTypeDuplicates,
    sourceMentions,
  };
}

function printReport(r: Report): void {
  const { with: descWith, without: descWithout } = r.shortDescCoverage;
  const total = r.total;
  const pct = total === 0 ? 0 : Math.round((descWith / total) * 100);

  console.log("\n──────── ingestion report ────────");
  console.log(`wikis:                       ${total}`);
  console.log("");
  console.log("by subject_type:");
  for (const [type, ws] of [...r.bySubjectType.entries()].sort()) {
    console.log(`  ${type.padEnd(15)} ${ws.length}`);
    for (const w of ws) {
      const sd = w.shortDescription ? ` — ${w.shortDescription}` : "";
      console.log(`    - ${w.label}${sd}`);
    }
  }
  console.log("");
  console.log(`short_description coverage:  ${descWith}/${total} (${pct}%)`);
  console.log(`wiki ↔ wiki edges:           ${r.wikiToWikiLinks}`);
  console.log(`dangling / red links:        ${r.danglingLinks.length}`);
  if (r.danglingLinks.length > 0) {
    for (const d of r.danglingLinks.slice(0, 10)) {
      console.log(`  ${d.from} → ${d.href}`);
    }
    if (r.danglingLinks.length > 10) {
      console.log(`  … and ${r.danglingLinks.length - 10} more`);
    }
  }
  console.log(`cross-type slug duplicates:  ${r.crossTypeDuplicates.length}`);
  for (const d of r.crossTypeDuplicates) {
    console.log(`  ${d.slug} appears under: ${d.types.join(", ")}`);
  }
  console.log("");
  console.log("source → # wikis citing it:");
  for (const [src, count] of r.sourceMentions) {
    console.log(`  ${src.padEnd(30)} ${count}`);
  }
  console.log("──────────────────────────────────\n");
}

// ── Main ───────────────────────────────────────────────────────────

async function pause(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(prompt);
  rl.close();
}

async function main(): Promise<void> {
  setupSmokeDir();
  const { dbPath } = preflight();
  const db = openDbReadOnly(dbPath);

  console.log(`smoke dir:    ${SMOKE_DIR}`);
  console.log(`instance:     ${INSTANCE} (db: ${dbPath})`);
  console.log(`books:        ${BOOK_RANGE.join(", ")}`);
  console.log(`timeout/book: ${TIMEOUT_MS / 1000}s`);

  const book = await fetchConfessions();

  const sourceFiles: string[] = [];
  for (const n of BOOK_RANGE) {
    const text = sliceBook(book, n);
    const filename = `book-${String(n).padStart(2, "0")}-${ROMAN[n - 1].toLowerCase()}.md`;
    const sourceRel = `sources/${filename}`;
    const sourceAbs = join(SMOKE_DIR, sourceRel);
    sourceFiles.push(sourceRel);

    console.log(`\n──── Book ${n} (${ROMAN[n - 1]}) — ${text.length} chars ────`);

    if (existsSync(sourceAbs)) {
      console.log(`Already exists at ${sourceRel} — skipping write (re-trigger by deleting it first).`);
    } else {
      writeFileSync(
        sourceAbs,
        [
          `# Confessions, Book ${ROMAN[n - 1]}`,
          "",
          "_From E. B. Pusey's translation of Augustine of Hippo's Confessions, via Project Gutenberg eBook 3296._",
          "",
          text,
          "",
        ].join("\n"),
      );
      console.log(`Wrote ${sourceAbs}`);
    }

    console.log(`Waiting for ingestor (timeout ${TIMEOUT_MS / 1000}s)`);
    const t0 = Date.now();
    const result = await waitForCompletion(db, sourceRel, TIMEOUT_MS);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (result.status === "completed") {
      console.log(`✓ Book ${n} ingested in ${elapsed}s`);
    } else if (result.status === "failed") {
      console.log(`✗ Book ${n} FAILED after ${elapsed}s — ${result.error ?? "(no error)"}`);
    } else {
      console.log(
        `⏱  Book ${n} timed out after ${elapsed}s. Check the daemon log:\n   tail -F ~/.arkeon-wiki/${INSTANCE}/arkeon.log`,
      );
    }

    const wikis = scanWikis();
    const report = buildReport(wikis, sourceFiles);
    printReport(report);

    const isLast = n === BOOK_RANGE[BOOK_RANGE.length - 1];
    if (PAUSE && !isLast) {
      await pause(
        `Browse ${join(SMOKE_DIR, "wiki")}/ to inspect, then press ENTER to continue with Book ${BOOK_RANGE[BOOK_RANGE.indexOf(n) + 1]} (Ctrl-C to stop). `,
      );
    }
  }

  console.log("\nDone. Generated wikis are in:");
  console.log(`  ${join(SMOKE_DIR, "wiki")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
