// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end smoke test for the substrate surface.
 *
 * Spins up the API in-process against a temp watched root, lets the
 * watcher reconcile, then exercises the six commands plus the reader.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, createSql, initDb } from "../../src/server/lib/sql.js";
import { runMigrations } from "../../src/schema/migrate.js";
import { startWatching, stopWatching } from "../../src/server/lib/fs-watcher.js";
import { createApp } from "../../src/server/app.js";

let workdir: string;
let app: ReturnType<typeof createApp>;

// Disable the background reconcile loop for this suite — it tests
// watcher + API behavior, not reconcile timing, and a stray sweep
// would race with the writeFileSync calls below.
const savedReconcileInterval = process.env.ARKEON_WIKI_RECONCILE_INTERVAL_SECONDS;
process.env.ARKEON_WIKI_RECONCILE_INTERVAL_SECONDS = "0";

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "arkeon-substrate-"));
  const dbPath = join(workdir, "arke.db");
  initDb(dbPath);
  await runMigrations({ dbPath });

  mkdirSync(join(workdir, "iarpa/sources"), { recursive: true });
  mkdirSync(join(workdir, "chartbook/sources"), { recursive: true });
  writeFileSync(
    join(workdir, "iarpa/article.html"),
    `<!doctype html><html><head><title>India</title><meta name="short_description" content="On India."></head><body><p>See <a class="wikilink" href="./sources/paper.md" data-quote="hello">paper</a>.</p></body></html>`,
  );
  writeFileSync(
    join(workdir, "iarpa/sources/paper.md"),
    `# Paper\n\nThis is a markdown source about [[india/article]] and [[missing-target]].\n`,
  );
  writeFileSync(
    join(workdir, "chartbook/about.html"),
    `<!doctype html><html><head><title>Chartbook</title></head><body><p>chart</p></body></html>`,
  );
  // chloroplast: unique fs-path basename match. HTML href from
  // iarpa/notes.html resolves to iarpa/chloroplast.html; MD
  // [[chloroplast]] from iarpa/sources/notes.md stays as a literal
  // slug. /redlinks should merge the slug into the fs-path row because
  // the slug's basename has exactly one fs-path match.
  writeFileSync(
    join(workdir, "iarpa/notes.html"),
    `<!doctype html><html><head><title>Notes</title></head><body><p>See <a class="wikilink" href="./chloroplast.html">chloroplast</a>.</p></body></html>`,
  );
  writeFileSync(
    join(workdir, "iarpa/sources/notes.md"),
    `# Notes\n\nSee [[chloroplast]] for context.\n`,
  );
  // biology: cross-folder same-basename collision. Two distinct
  // fs-path redlinks (iarpa/biology.html, chartbook/biology.html) and
  // a MD slug [[biology]] whose basename has TWO fs-path matches.
  // /redlinks should keep all three as separate rows — the slug
  // can't merge because it's ambiguous, and creating either fs-path
  // file does NOT resolve the other.
  writeFileSync(
    join(workdir, "iarpa/biology-source.html"),
    `<!doctype html><html><head><title>Biology (iarpa)</title></head><body><p>See <a class="wikilink" href="./biology.html">biology overview</a>.</p></body></html>`,
  );
  writeFileSync(
    join(workdir, "chartbook/biology-source.html"),
    `<!doctype html><html><head><title>Biology (chartbook)</title></head><body><p>See <a class="wikilink" href="./biology.html">biology overview</a>.</p></body></html>`,
  );
  writeFileSync(
    join(workdir, "iarpa/sources/bio.md"),
    `# Bio\n\nRelated: [[biology]].\n`,
  );
  // Two articles tagged with <meta name="topic" content="..."> values
  // so the has_property / not_property filters have something
  // distinguishable to match on. No content beyond the meta tags —
  // these are smoke fixtures, not corpus material.
  writeFileSync(
    join(workdir, "iarpa/topic-us-china.html"),
    `<!doctype html><html><head><title>Topic: us-china</title><meta name="topic" content="us-china"><meta name="status" content="draft"></head><body><p>us-china body</p></body></html>`,
  );
  writeFileSync(
    join(workdir, "iarpa/topic-macro.html"),
    `<!doctype html><html><head><title>Topic: macro</title><meta name="topic" content="macro"><meta name="status" content="published"></head><body><p>macro body</p></body></html>`,
  );
  // Derived-asset fixture: simulate the file layout a PDF extractor
  // would land — the binary itself plus a `.sidecars/<X>.pdf.assets/`
  // page-render asset. Tests assert properties.derived_from points
  // back at the binary, and that the existing has_property /
  // not_property filter excludes the derived asset.
  mkdirSync(join(workdir, ".sidecars/iarpa"), { recursive: true });
  writeFileSync(
    join(workdir, "iarpa/derived-fixture.pdf"),
    "%PDF-1.4 derived-fixture placeholder\n",
  );
  mkdirSync(
    join(workdir, ".sidecars/iarpa/derived-fixture.pdf.assets"),
    { recursive: true },
  );
  writeFileSync(
    join(workdir, ".sidecars/iarpa/derived-fixture.pdf.assets/page-1.png"),
    "derived-page-render placeholder",
  );

  await startWatching(workdir);
  app = createApp();
});

afterAll(async () => {
  await stopWatching();
  closeDb();
  rmSync(workdir, { recursive: true, force: true });
  if (savedReconcileInterval === undefined) {
    delete process.env.ARKEON_WIKI_RECONCILE_INTERVAL_SECONDS;
  } else {
    process.env.ARKEON_WIKI_RECONCILE_INTERVAL_SECONDS = savedReconcileInterval;
  }
});

describe("substrate", () => {
  it("indexes artifacts with full relative paths", async () => {
    const sql = createSql();
    const rows = await sql`SELECT path, kind FROM artifacts ORDER BY path`;
    const byPath = new Map(rows.map((r) => [r.path as string, r.kind as string]));
    expect(byPath.get("iarpa/article.html")).toBe("text");
    expect(byPath.get("iarpa/sources/paper.md")).toBe("text");
    expect(byPath.get("chartbook/about.html")).toBe("text");
  });

  it("POST /query surfaces artifact.properties parsed from <meta> tags", async () => {
    // Regression guard: sql.ts:hydrateRow auto-parses `properties` from
    // JSON-string to object. A redundant parseJsonObject in entities.ts
    // used to stringify the already-parsed object via JSON.parse("[object
    // Object]"), throw silently, and return {} — so /query always emitted
    // properties: {} even when the row had real <meta> fields. Assert
    // the value actually round-trips.
    const res = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folder: "iarpa/article.html" }),
      }),
    );
    const body = (await res.json()) as {
      artifacts: Array<{ path: string; properties: Record<string, unknown> }>;
    };
    const article = body.artifacts.find((a) => a.path === "iarpa/article.html");
    expect(article).toBeDefined();
    expect(article!.properties.short_description).toBe("On India.");
  });

  it("POST /query has_property: key-only presence check", async () => {
    const res = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folder: "iarpa", has_property: ["topic"] }),
      }),
    );
    const body = (await res.json()) as { artifacts: Array<{ path: string }> };
    const paths = body.artifacts.map((a) => a.path).sort();
    expect(paths).toContain("iarpa/topic-us-china.html");
    expect(paths).toContain("iarpa/topic-macro.html");
    // article.html lacks `topic` — has short_description instead.
    expect(paths).not.toContain("iarpa/article.html");
  });

  it("POST /query has_property: key:value match", async () => {
    const res = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          folder: "iarpa",
          has_property: ["topic:us-china"],
        }),
      }),
    );
    const body = (await res.json()) as { artifacts: Array<{ path: string }> };
    const paths = body.artifacts.map((a) => a.path);
    expect(paths).toEqual(["iarpa/topic-us-china.html"]);
  });

  it("POST /query has_property AND-composes across multiple entries", async () => {
    const res = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          folder: "iarpa",
          has_property: ["topic", "status:draft"],
        }),
      }),
    );
    const body = (await res.json()) as { artifacts: Array<{ path: string }> };
    const paths = body.artifacts.map((a) => a.path);
    expect(paths).toEqual(["iarpa/topic-us-china.html"]);
  });

  it("POST /query not_property: excludes artifacts with the key set", async () => {
    const res = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          folder: "iarpa",
          not_property: ["topic"],
        }),
      }),
    );
    const body = (await res.json()) as { artifacts: Array<{ path: string }> };
    const paths = body.artifacts.map((a) => a.path);
    expect(paths).not.toContain("iarpa/topic-us-china.html");
    expect(paths).not.toContain("iarpa/topic-macro.html");
    // article.html has no `topic`, should still surface.
    expect(paths).toContain("iarpa/article.html");
  });

  it("POST /query not_property key:value keeps artifacts whose value differs", async () => {
    const res = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          folder: "iarpa",
          not_property: ["topic:us-china"],
        }),
      }),
    );
    const body = (await res.json()) as { artifacts: Array<{ path: string }> };
    const paths = body.artifacts.map((a) => a.path);
    expect(paths).not.toContain("iarpa/topic-us-china.html");
    expect(paths).toContain("iarpa/topic-macro.html");
  });

  it("POST /query rejects has_property entries that aren't strings", async () => {
    const res = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ has_property: [42] }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("derived assets carry properties.derived_from pointing at the source binary", async () => {
    // The page-render PNG under .sidecars/<X>.pdf.assets/ should
    // surface derived_from = "iarpa/derived-fixture.pdf" without any
    // extractor running — the substrate detects the convention from
    // the path alone.
    const res = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          folder: ".sidecars/iarpa/derived-fixture.pdf.assets",
          kinds: ["asset"],
        }),
      }),
    );
    const body = (await res.json()) as {
      artifacts: Array<{ path: string; properties: Record<string, unknown> }>;
    };
    const page = body.artifacts.find((a) =>
      a.path.endsWith("/page-1.png"),
    );
    expect(page).toBeDefined();
    expect(page!.properties.derived_from).toBe("iarpa/derived-fixture.pdf");
  });

  it("not_property: ['derived_from'] hides page renders from kinds:[asset] queries", async () => {
    // The "what binaries do I have?" case from #198. The PDF should
    // surface; its page-render should not.
    const res = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kinds: ["asset"],
          not_property: ["derived_from"],
        }),
      }),
    );
    const body = (await res.json()) as { artifacts: Array<{ path: string }> };
    const paths = body.artifacts.map((a) => a.path);
    expect(paths).toContain("iarpa/derived-fixture.pdf");
    expect(paths).not.toContain(
      ".sidecars/iarpa/derived-fixture.pdf.assets/page-1.png",
    );
  });

  it("has_property: ['derived_from'] selects the page renders alone", async () => {
    // The "what visual assets exist?" case from #198 — inverse of the
    // not_property test.
    const res = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kinds: ["asset"],
          has_property: ["derived_from"],
        }),
      }),
    );
    const body = (await res.json()) as { artifacts: Array<{ path: string }> };
    const paths = body.artifacts.map((a) => a.path);
    expect(paths).toContain(
      ".sidecars/iarpa/derived-fixture.pdf.assets/page-1.png",
    );
    expect(paths).not.toContain("iarpa/derived-fixture.pdf");
  });

  it("GET /stats returns corpus size breakdown", async () => {
    const res = await app.fetch(new Request("http://test/stats"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifacts: { total: number; text: number; asset: number };
      links: number;
      redlinks: number;
      tag_keys: number;
      tag_keys_top: Array<{ key: string; n: number }>;
    };
    expect(body.artifacts.total).toBeGreaterThan(0);
    expect(body.artifacts.total).toBe(body.artifacts.text + body.artifacts.asset);
    expect(body.links).toBeGreaterThan(0);
    expect(body.redlinks).toBeGreaterThan(0); // missing-target from setup
    expect(body.tag_keys).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.tag_keys_top)).toBe(true);
    expect(body.tag_keys_top.length).toBeLessThanOrEqual(10);
    expect(body.tag_keys_top.length).toBeLessThanOrEqual(body.tag_keys);
  });

  it("GET /stats tag_keys_top orders by row count desc, ties alphabetical", async () => {
    // Self-contained: post three distinct keys at three distinct row
    // counts, then assert ordering. Cleans up after itself so other
    // tests see the same starting state.
    const fixtures = [
      // key, [paths to tag]
      ["topN-alpha", ["iarpa/article.html"]],
      [
        "topN-beta",
        ["iarpa/article.html", "iarpa/notes.html"],
      ],
      [
        "topN-gamma",
        [
          "iarpa/article.html",
          "iarpa/notes.html",
          "chartbook/about.html",
        ],
      ],
    ] as const;
    for (const [key, paths] of fixtures) {
      for (const path of paths) {
        await app.fetch(
          new Request("http://test/tag", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path, key, value: "1" }),
          }),
        );
      }
    }
    const res = await app.fetch(new Request("http://test/stats"));
    const body = (await res.json()) as {
      tag_keys_top: Array<{ key: string; n: number }>;
    };
    const ours = body.tag_keys_top.filter((r) => r.key.startsWith("topN-"));
    expect(ours).toEqual([
      { key: "topN-gamma", n: 3 },
      { key: "topN-beta", n: 2 },
      { key: "topN-alpha", n: 1 },
    ]);
    for (const [key, paths] of fixtures) {
      for (const path of paths) {
        await app.fetch(
          new Request("http://test/untag", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path, key }),
          }),
        );
      }
    }
  });

  it("GET /stats?tag_keys_top=N overrides the default 10-row cap", async () => {
    // Seed three distinct keys, then ask for 2 — only the top 2 by
    // count should come back, ordered desc.
    const seeded = [
      ["limit-alpha", ["iarpa/article.html"]],
      ["limit-beta", ["iarpa/article.html", "iarpa/notes.html"]],
      [
        "limit-gamma",
        ["iarpa/article.html", "iarpa/notes.html", "chartbook/about.html"],
      ],
    ] as const;
    for (const [key, paths] of seeded) {
      for (const path of paths) {
        await app.fetch(
          new Request("http://test/tag", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path, key, value: "1" }),
          }),
        );
      }
    }
    const res = await app.fetch(
      new Request("http://test/stats?tag_keys_top=2"),
    );
    const body = (await res.json()) as {
      tag_keys_top: Array<{ key: string; n: number }>;
    };
    expect(body.tag_keys_top.length).toBe(2);
    const ours = body.tag_keys_top.filter((r) => r.key.startsWith("limit-"));
    expect(ours).toEqual([
      { key: "limit-gamma", n: 3 },
      { key: "limit-beta", n: 2 },
    ]);

    const bad = await app.fetch(
      new Request("http://test/stats?tag_keys_top=101"),
    );
    expect(bad.status).toBe(400);

    const negative = await app.fetch(
      new Request("http://test/stats?tag_keys_top=-1"),
    );
    expect(negative.status).toBe(400);

    for (const [key, paths] of seeded) {
      for (const path of paths) {
        await app.fetch(
          new Request("http://test/untag", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path, key }),
          }),
        );
      }
    }
  });

  it("POST /query honors order_by + order", async () => {
    const asc = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order_by: "path", order: "asc", limit: 5 }),
      }),
    );
    const body = (await asc.json()) as { artifacts: Array<{ path: string }> };
    const paths = body.artifacts.map((a) => a.path);
    expect(paths).toEqual([...paths].sort());
  });

  it("POST /query rejects unknown order_by", async () => {
    const res = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order_by: "bogus" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("captures wikilink data-* attributes in links.attrs", async () => {
    const sql = createSql();
    const rows = await sql`
      SELECT source_path, target_path, attrs FROM links
      WHERE source_path = 'iarpa/article.html'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].target_path).toBe("iarpa/sources/paper.md");
    const attrs = JSON.parse(rows[0].attrs as string);
    expect(attrs.quote).toBe("hello");
  });

  it("extracts MD [[X]] links", async () => {
    const sql = createSql();
    const rows = await sql`
      SELECT target_path FROM links
      WHERE source_path = 'iarpa/sources/paper.md'
      ORDER BY target_path
    `;
    const targets = rows.map((r) => r.target_path);
    // [[india/article]] resolves to the relative path; [[missing-target]] stays verbatim as a redlink.
    expect(targets).toContain("missing-target");
  });

  it("POST /query filters by folder + has_tag composition", async () => {
    const res = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folder: "iarpa" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifacts: Array<{ path: string }>;
      total: number;
    };
    const paths = body.artifacts.map((a) => a.path);
    expect(paths).toContain("iarpa/article.html");
    expect(paths).toContain("iarpa/sources/paper.md");
    expect(paths).not.toContain("chartbook/about.html");
  });

  it("POST /tag + GET /tags round trips; first call returns action=created", async () => {
    const tagRes = await app.fetch(
      new Request("http://test/tag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "iarpa/article.html",
          key: "processed-by",
          value: "editor",
        }),
      }),
    );
    expect(tagRes.status).toBe(200);
    const created = (await tagRes.json()) as {
      ok: boolean;
      action: string;
      previous_value: string | null;
      value: string;
    };
    expect(created.ok).toBe(true);
    expect(created.action).toBe("created");
    expect(created.previous_value).toBeNull();
    expect(created.value).toBe("editor");

    const tagsRes = await app.fetch(
      new Request("http://test/tags?path=iarpa/article.html"),
    );
    const body = (await tagsRes.json()) as { tags: Record<string, string> };
    expect(body.tags["processed-by"]).toBe("editor");
  });

  it("POST /tag re-tag with same value → action=unchanged", async () => {
    // Relies on the prior "POST /tag" test having tagged with value="editor".
    const res = await app.fetch(
      new Request("http://test/tag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "iarpa/article.html",
          key: "processed-by",
          value: "editor",
        }),
      }),
    );
    const body = (await res.json()) as {
      action: string;
      previous_value: string | null;
    };
    expect(body.action).toBe("unchanged");
    expect(body.previous_value).toBe("editor");
  });

  it("POST /tag re-tag with different value → action=updated + previous_value surfaces", async () => {
    // Worker collision detection: B sees A's stomped value in
    // previous_value, can log/decide what to do.
    const res = await app.fetch(
      new Request("http://test/tag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "iarpa/article.html",
          key: "processed-by",
          value: "writer",
        }),
      }),
    );
    const body = (await res.json()) as {
      action: string;
      previous_value: string | null;
      value: string;
    };
    expect(body.action).toBe("updated");
    expect(body.previous_value).toBe("editor");
    expect(body.value).toBe("writer");

    // Restore the original so downstream tests see "editor" as expected.
    await app.fetch(
      new Request("http://test/tag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "iarpa/article.html",
          key: "processed-by",
          value: "editor",
        }),
      }),
    );
  });

  it("POST /query with not_tag excludes tagged artifacts (key-only)", async () => {
    const res = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          folder: "iarpa",
          not_tag: ["processed-by"],
        }),
      }),
    );
    const body = (await res.json()) as { artifacts: Array<{ path: string }> };
    const paths = body.artifacts.map((a) => a.path);
    expect(paths).not.toContain("iarpa/article.html");
    expect(paths).toContain("iarpa/sources/paper.md");
  });

  it("POST /query with not_tag key:value composition", async () => {
    const res = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          folder: "iarpa",
          not_tag: ["processed-by:editor"],
        }),
      }),
    );
    const body = (await res.json()) as { artifacts: Array<{ path: string }> };
    const paths = body.artifacts.map((a) => a.path);
    expect(paths).not.toContain("iarpa/article.html");
  });

  it("GET /backlinks returns inbound rows + exists + demand for a real artifact", async () => {
    const res = await app.fetch(
      new Request("http://test/backlinks?path=iarpa/sources/paper.md"),
    );
    const body = (await res.json()) as {
      path: string;
      exists: boolean;
      demand: number;
      backlinks: Array<{ source_path: string; attrs: Record<string, string> }>;
    };
    expect(body.exists).toBe(true);
    expect(body.demand).toBe(body.backlinks.length);
    const first = body.backlinks.find((b) => b.source_path === "iarpa/article.html");
    expect(first).toBeDefined();
    expect(first!.attrs.quote).toBe("hello");
  });

  it("GET /backlinks surfaces inbound rows for unresolved redlink targets", async () => {
    // missing-target is referenced by iarpa/sources/paper.md but is
    // not itself in artifacts — should still return the inbound row
    // with exists=false.
    const res = await app.fetch(
      new Request("http://test/backlinks?path=missing-target"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      exists: boolean;
      demand: number;
      backlinks: Array<{ source_path: string }>;
    };
    expect(body.exists).toBe(false);
    expect(body.demand).toBeGreaterThan(0);
    expect(body.backlinks.some((b) => b.source_path === "iarpa/sources/paper.md")).toBe(true);
  });

  it("GET /backlinks on a completely unknown path: exists=false, demand=0", async () => {
    const res = await app.fetch(
      new Request("http://test/backlinks?path=never-cited-by-anyone"),
    );
    const body = (await res.json()) as {
      exists: boolean;
      demand: number;
      backlinks: unknown[];
    };
    expect(body.exists).toBe(false);
    expect(body.demand).toBe(0);
    expect(body.backlinks).toEqual([]);
  });

  it("GET /redlinks lists unresolved targets with intact linked_from paths", async () => {
    const res = await app.fetch(new Request("http://test/redlinks"));
    const body = (await res.json()) as {
      redlinks: Array<{ target_path: string; demand: number; linked_from: string[] }>;
    };
    const targets = body.redlinks.map((r) => r.target_path);
    expect(targets).toContain("missing-target");
    // Regression guard for the GROUP_CONCAT separator bug: linked_from
    // must be intact source paths, not character-shredded fragments.
    const missing = body.redlinks.find((r) => r.target_path === "missing-target")!;
    expect(missing.linked_from).toEqual(["iarpa/sources/paper.md"]);
    expect(missing.demand).toBe(1);
  });

  it("GET /redlinks merges MD slug into a UNIQUE fs-path basename match", async () => {
    // iarpa/notes.html links to ./chloroplast.html (fs-path form
    // iarpa/chloroplast.html). iarpa/sources/notes.md has [[chloroplast]]
    // (slug). Creating iarpa/chloroplast.html resolves BOTH anchors —
    // the slug auto-converges via shortest-unique-basename. So the
    // redlink queue surfaces one row; demand=2 reflects the real
    // unit of work.
    const res = await app.fetch(new Request("http://test/redlinks"));
    const body = (await res.json()) as {
      redlinks: Array<{ target_path: string; demand: number; linked_from: string[] }>;
      total: number;
    };
    const chloroplastRows = body.redlinks.filter(
      (r) =>
        r.target_path === "chloroplast" ||
        r.target_path.endsWith("/chloroplast.html") ||
        r.target_path === "chloroplast.html",
    );
    expect(chloroplastRows).toHaveLength(1);
    const row = chloroplastRows[0];
    expect(row.target_path).toBe("iarpa/chloroplast.html");
    expect(row.demand).toBe(2);
    expect(row.linked_from.sort()).toEqual([
      "iarpa/notes.html",
      "iarpa/sources/notes.md",
    ]);
  });

  it("GET /redlinks keeps cross-folder same-basename fs-paths as separate gaps", async () => {
    // iarpa/biology-source.html and chartbook/biology-source.html each
    // link to ./biology.html — two distinct unresolved fs-paths
    // (iarpa/biology.html, chartbook/biology.html). They are NOT the
    // same gap: creating iarpa/biology.html doesn't resolve the
    // chartbook anchor and vice versa. The substrate's MD resolver
    // would punt on [[biology]] with two matches, so the slug also
    // stays as its own row rather than merging into either fs-path.
    const res = await app.fetch(new Request("http://test/redlinks"));
    const body = (await res.json()) as {
      redlinks: Array<{ target_path: string; demand: number; linked_from: string[] }>;
    };
    const biologyRows = body.redlinks.filter(
      (r) =>
        r.target_path === "biology" ||
        r.target_path === "iarpa/biology.html" ||
        r.target_path === "chartbook/biology.html",
    );
    expect(biologyRows).toHaveLength(3);

    const iarpaRow = biologyRows.find((r) => r.target_path === "iarpa/biology.html")!;
    expect(iarpaRow.demand).toBe(1);
    expect(iarpaRow.linked_from).toEqual(["iarpa/biology-source.html"]);

    const chartbookRow = biologyRows.find((r) => r.target_path === "chartbook/biology.html")!;
    expect(chartbookRow.demand).toBe(1);
    expect(chartbookRow.linked_from).toEqual(["chartbook/biology-source.html"]);

    const slugRow = biologyRows.find((r) => r.target_path === "biology")!;
    expect(slugRow.demand).toBe(1);
    expect(slugRow.linked_from).toEqual(["iarpa/sources/bio.md"]);
  });

  it("POST /query filters by documented `kinds` array (not legacy `kind`)", async () => {
    const res = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folder: "iarpa", kinds: ["text"] }),
      }),
    );
    const body = (await res.json()) as { artifacts: Array<{ path: string; kind: string }> };
    expect(body.artifacts.length).toBeGreaterThan(0);
    expect(body.artifacts.every((a) => a.kind === "text")).toBe(true);
  });

  it("POST /query rejects unknown kinds", async () => {
    const res = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kinds: ["bogus"] }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("POST /query with text invokes FTS5", async () => {
    const res = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "markdown" }),
      }),
    );
    const body = (await res.json()) as { artifacts: Array<{ path: string }> };
    const paths = body.artifacts.map((a) => a.path);
    expect(paths).toContain("iarpa/sources/paper.md");
  });

  it("POST /untag removes a tag → existed=true", async () => {
    const res = await app.fetch(
      new Request("http://test/untag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "iarpa/article.html", key: "processed-by" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; existed: boolean };
    expect(body.ok).toBe(true);
    expect(body.existed).toBe(true);

    const tagsRes = await app.fetch(
      new Request("http://test/tags?path=iarpa/article.html"),
    );
    const tags = (await tagsRes.json()) as { tags: Record<string, string> };
    expect(tags.tags["processed-by"]).toBeUndefined();
  });

  it("POST /untag on a non-existent tag returns ok=true, existed=false (idempotent)", async () => {
    const res = await app.fetch(
      new Request("http://test/untag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "iarpa/article.html", key: "never-set" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; existed: boolean };
    expect(body.ok).toBe(true);
    expect(body.existed).toBe(false);
  });

  it("GET / serves a directory listing of the watched root", async () => {
    const res = await app.fetch(new Request("http://test/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const text = await res.text();
    expect(text).toContain("iarpa/");
    expect(text).toContain("chartbook/");
  });

  it("GET /<dir>/ renders artifact.label (from <title>) next to filename", async () => {
    // chartbook/about.html has <title>Chartbook</title>; the
    // directory listing should show that label alongside the
    // raw filename so the link text isn't just the slug.
    const res = await app.fetch(new Request("http://test/chartbook/"));
    expect(res.status).toBe(200);
    const text = await res.text();
    // Label first, filename in muted suffix.
    expect(text).toMatch(/Chartbook\s*<span[^>]*>\(about\.html\)<\/span>/);
  });

  it("GET /<dir>/ falls back to filename when label equals basename", async () => {
    // Markdown files derive label from the filename slug (no <title>),
    // so paper.md → label "paper". The renderer should render the
    // filename as the anchor, with no `(paper.md)` muted suffix —
    // anything else would be visual noise.
    const res = await app.fetch(new Request("http://test/iarpa/sources/"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("paper.md");
    expect(text).not.toMatch(/paper\s*<span[^>]*>\(paper\.md\)<\/span>/);
  });

  it("GET /<file> rewrites wikilinks and marks unresolved as redlinks", async () => {
    const res = await app.fetch(new Request("http://test/iarpa/article.html"));
    expect(res.status).toBe(200);
    const text = await res.text();
    // The resolved wikilink still carries its class, no redlink.
    expect(text).toContain(`class="wikilink"`);
    expect(text).not.toMatch(/wikilink[^"]*redlink/);
  });

  it("HTML serve emits a 3-component ETag (mtime-size-corpus)", async () => {
    // HTML rendering depends on `knownPaths`, so the ETag has to mix
    // a corpus fingerprint in alongside the file's mtime + size.
    // Binary serves stay at the cheap two-component form (asserted
    // by the streaming-binary test below).
    const res = await app.fetch(new Request("http://test/iarpa/article.html"));
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toMatch(/^W\/"\d+-\d+-\d+-\d+"$/);
    expect(res.headers.get("cache-control")).toBe("no-cache, must-revalidate");
  });

  it("binary serve emits a 2-component ETag (mtime-size)", async () => {
    const res = await app.fetch(
      new Request("http://test/iarpa/derived-fixture.pdf"),
    );
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toMatch(/^W\/"\d+-\d+"$/);
  });

  it("HTML ETag invalidates when a new artifact lands in the corpus", async () => {
    // The HTML render path flips the `redlink` class based on
    // `knownPaths`. Without a corpus fingerprint in the ETag, a
    // matching mtime + size would 304 even after a previously-
    // unresolved target lands — the cached page would keep the
    // stale class. The corpus version component prevents that.
    const first = await app.fetch(
      new Request("http://test/iarpa/article.html"),
    );
    const firstEtag = first.headers.get("etag")!;
    expect(firstEtag).toBeTruthy();

    // Land a new file in the corpus and wait for the watcher to index it.
    const dropName = "iarpa/etag-bump-target.html";
    writeFileSync(
      join(workdir, dropName),
      `<!doctype html><html><head><title>Bump</title></head><body>bump</body></html>`,
    );
    const sql = createSql();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const rows = await sql`SELECT 1 FROM artifacts WHERE path = ${dropName}`;
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const second = await app.fetch(
      new Request("http://test/iarpa/article.html"),
    );
    const secondEtag = second.headers.get("etag")!;
    expect(secondEtag).not.toBe(firstEtag);
    // A request bearing the OLD etag must now miss the cache.
    const validate = await app.fetch(
      new Request("http://test/iarpa/article.html", {
        headers: { "if-none-match": firstEtag },
      }),
    );
    expect(validate.status).toBe(200);
  });

  it("If-None-Match with the current ETag returns 304 + empty body", async () => {
    const first = await app.fetch(
      new Request("http://test/iarpa/article.html"),
    );
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const second = await app.fetch(
      new Request("http://test/iarpa/article.html", {
        headers: { "if-none-match": etag },
      }),
    );
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
    expect(second.headers.get("cache-control")).toBe("no-cache, must-revalidate");
    // 304 body must be empty per RFC 9110.
    expect(await second.text()).toBe("");
  });

  it("If-None-Match: * is the wildcard match → 304", async () => {
    const res = await app.fetch(
      new Request("http://test/iarpa/article.html", {
        headers: { "if-none-match": "*" },
      }),
    );
    expect(res.status).toBe(304);
  });

  it("If-None-Match with a stale ETag still returns the body", async () => {
    const res = await app.fetch(
      new Request("http://test/iarpa/article.html", {
        headers: { "if-none-match": 'W/"0-0"' },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(0);
  });

  it("binary serve streams the file with content-type + content-length", async () => {
    // derived-fixture.pdf is set up in beforeAll with deterministic
    // ASCII bytes — the reader should serve them verbatim with the
    // PDF content-type and a matching content-length.
    const res = await app.fetch(
      new Request("http://test/iarpa/derived-fixture.pdf"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const len = Number(res.headers.get("content-length"));
    expect(len).toBeGreaterThan(0);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(len);
    expect(new TextDecoder().decode(bytes)).toBe(
      "%PDF-1.4 derived-fixture placeholder\n",
    );
  });

  it("directory listing paginates with offset / limit + total + prev/next links", async () => {
    // Self-contained fixture so the page math is deterministic
    // regardless of other tests dropping files in iarpa/.
    mkdirSync(join(workdir, "pagination-fixture"), { recursive: true });
    for (let i = 1; i <= 12; i++) {
      writeFileSync(
        join(workdir, "pagination-fixture", `file-${String(i).padStart(2, "0")}.txt`),
        `entry ${i}`,
      );
    }

    const first = await app.fetch(
      new Request("http://test/pagination-fixture/?limit=5"),
    );
    expect(first.status).toBe(200);
    const firstHtml = await first.text();
    expect(firstHtml).toContain("1–5 of 12");
    expect(firstHtml).toContain("file-01.txt");
    expect(firstHtml).toContain("file-05.txt");
    expect(firstHtml).not.toContain("file-06.txt");
    expect(firstHtml).toContain('rel="next"');
    expect(firstHtml).not.toContain('rel="prev"');

    const middle = await app.fetch(
      new Request("http://test/pagination-fixture/?limit=5&offset=5"),
    );
    const middleHtml = await middle.text();
    expect(middleHtml).toContain("6–10 of 12");
    expect(middleHtml).toContain('rel="prev"');
    expect(middleHtml).toContain('rel="next"');
    expect(middleHtml).toContain("file-06.txt");
    expect(middleHtml).toContain("file-10.txt");
    expect(middleHtml).not.toContain("file-01.txt");

    const last = await app.fetch(
      new Request("http://test/pagination-fixture/?limit=5&offset=10"),
    );
    const lastHtml = await last.text();
    expect(lastHtml).toContain("11–12 of 12");
    expect(lastHtml).toContain('rel="prev"');
    expect(lastHtml).not.toContain('rel="next"');
  });

  it("directory listing sort=mtime orders entries newest-first", async () => {
    mkdirSync(join(workdir, "mtime-fixture"), { recursive: true });
    const files = ["a.txt", "b.txt", "c.txt"];
    for (const n of files) {
      writeFileSync(join(workdir, "mtime-fixture", n), n);
    }
    // a oldest → c newest.
    utimesSync(
      join(workdir, "mtime-fixture/a.txt"),
      new Date("2026-01-01"),
      new Date("2026-01-01"),
    );
    utimesSync(
      join(workdir, "mtime-fixture/b.txt"),
      new Date("2026-01-02"),
      new Date("2026-01-02"),
    );
    utimesSync(
      join(workdir, "mtime-fixture/c.txt"),
      new Date("2026-01-03"),
      new Date("2026-01-03"),
    );

    const res = await app.fetch(
      new Request("http://test/mtime-fixture/?sort=mtime"),
    );
    const html = await res.text();
    const idxA = html.indexOf(">a.txt<");
    const idxB = html.indexOf(">b.txt<");
    const idxC = html.indexOf(">c.txt<");
    expect(idxA).toBeGreaterThan(0);
    expect(idxB).toBeGreaterThan(0);
    expect(idxC).toBeGreaterThan(0);
    // Newest first → c, then b, then a.
    expect(idxC).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxA);
    // The sort link for mtime should carry the ark-active marker.
    expect(html).toMatch(/<a [^>]*class="ark-active"[^>]*>mtime<\/a>/);
  });

  it("invalid sort / limit / offset query params fall back to defaults", async () => {
    mkdirSync(join(workdir, "validation-fixture"), { recursive: true });
    writeFileSync(join(workdir, "validation-fixture/only.txt"), "x");
    const res = await app.fetch(
      new Request(
        "http://test/validation-fixture/?sort=bogus&limit=-7&offset=garbage",
      ),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // Default sort=name should be marked active.
    expect(html).toMatch(/<a [^>]*class="ark-active"[^>]*>name<\/a>/);
    // Single entry, default limit 200 → no pager.
    expect(html).not.toContain('rel="next"');
    expect(html).not.toContain('rel="prev"');
    expect(html).toContain("only.txt");
  });

  it("reader only marks redlinks on <a class='wikilink'>, not plain anchors", async () => {
    // Drop a fresh file with one wikilink (unresolved) and one plain anchor (unresolved).
    const fname = "iarpa/mixed-links.html";
    writeFileSync(
      join(workdir, fname),
      `<!doctype html><html><head><title>Mixed</title></head><body>
         <a class="wikilink" href="./nope-wiki">wiki</a>
         <a href="./nope-plain">plain</a>
       </body></html>`,
    );
    // Wait briefly for the watcher debounce + sync.
    const deadline = Date.now() + 2000;
    const sql = createSql();
    while (Date.now() < deadline) {
      const rows = await sql`SELECT 1 FROM artifacts WHERE path = ${fname}`;
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const res = await app.fetch(new Request(`http://test/${fname}`));
    const text = await res.text();
    // The plain anchor must NOT be rewritten — no redlink class.
    expect(text).toMatch(/<a href="\.\/nope-plain">plain<\/a>/);
    // The wikilink anchor SHOULD gain the redlink class.
    expect(text).toMatch(/<a class="wikilink redlink" href="\.\/nope-wiki">/);
  });

  it("preserves multiple wikilinks from one article to the same target", async () => {
    // Regression guard: the v0 (source_path, target_path) PK + INSERT OR
    // IGNORE silently dropped the second anchor — defeating the whole
    // point of `data-*` citation metadata. Each anchor must round-trip
    // through /backlinks with its own link_text and attrs.
    const fname = "iarpa/multi-cite.html";
    writeFileSync(
      join(workdir, fname),
      `<!doctype html><html><head><title>Multi-cite</title></head><body>
         <a class="wikilink" href="./sources/paper.md" data-quote="first" data-page="3">first cite</a>
         <a class="wikilink" href="./sources/paper.md" data-quote="second" data-page="7">second cite</a>
       </body></html>`,
    );
    const sql = createSql();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const rows = await sql`SELECT 1 FROM artifacts WHERE path = ${fname}`;
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const res = await app.fetch(
      new Request("http://test/backlinks?path=iarpa/sources/paper.md"),
    );
    const body = (await res.json()) as {
      backlinks: Array<{
        source_path: string;
        link_text: string;
        attrs: Record<string, string>;
      }>;
    };
    const fromMulti = body.backlinks.filter((b) => b.source_path === fname);
    expect(fromMulti.length).toBe(2);
    const quotes = fromMulti.map((b) => b.attrs.quote).sort();
    expect(quotes).toEqual(["first", "second"]);
    const pages = fromMulti.map((b) => b.attrs.page).sort();
    expect(pages).toEqual(["3", "7"]);
  });

  it("cascade-removes sidecar + assets when the source binary is unlinked", async () => {
    // Regression guard: when a binary disappears, the watcher must
    // evict its derived state — the sidecar HTML, the per-binary
    // assets directory, and every row pointing at any of it.
    // Otherwise /stats reports phantom sidecars and /query returns
    // kind='text' rows for binaries that no longer exist.
    //
    // Simulating a full PDF extraction would need the Python venv
    // (Docker-only). Stand in by creating the binary, its sidecar
    // file, and one asset by hand — the cascade-on-unlink path
    // doesn't care how the sidecar got there.
    const binaryRel = "iarpa/sources/orphan-probe.pdf";
    const sidecarRel = `.sidecars/${binaryRel}.html`;
    const assetRel = `.sidecars/iarpa/sources/orphan-probe.pdf.assets/page-1.png`;
    const binaryAbs = join(workdir, binaryRel);
    const sidecarAbs = join(workdir, sidecarRel);
    const assetAbs = join(workdir, assetRel);

    writeFileSync(binaryAbs, "%PDF-1.4 minimal placeholder\n");
    mkdirSync(join(workdir, ".sidecars/iarpa/sources"), { recursive: true });
    writeFileSync(
      sidecarAbs,
      `<!doctype html><html><head><title>Orphan probe</title></head><body><p>extracted text</p></body></html>`,
    );
    mkdirSync(join(workdir, ".sidecars/iarpa/sources/orphan-probe.pdf.assets"), {
      recursive: true,
    });
    writeFileSync(assetAbs, "fake png bytes");

    const sql = createSql();
    let deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const rows = await sql`
        SELECT path FROM artifacts
        WHERE path IN (${binaryRel}, ${sidecarRel}, ${assetRel})
      `;
      if (rows.length === 3) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    unlinkSync(binaryAbs);

    deadline = Date.now() + 3000;
    let evicted = false;
    while (Date.now() < deadline) {
      const rows = await sql`
        SELECT path FROM artifacts
        WHERE path IN (${binaryRel}, ${sidecarRel}, ${assetRel})
      `;
      if (rows.length === 0 && !existsSync(sidecarAbs) && !existsSync(assetAbs)) {
        evicted = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(evicted).toBe(true);
  });

  it("converges markdown [[X]] redlinks once the target artifact lands", async () => {
    // Regression guard: linking [[stale-target]] from a file that's
    // synced BEFORE its target should still resolve to the target's
    // real path once the target lands. Tests both reconcile-time
    // (covered by setup) and the live-watcher post-create case.

    // The link source has to be in place before the target arrives.
    // Use distinct names to avoid collision with other tests.
    const linker = "iarpa/staleness-source.md";
    writeFileSync(
      join(workdir, linker),
      `Pointing at [[late-arrival]] before the target exists.\n`,
    );
    const sql = createSql();
    let deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const rows = await sql`SELECT 1 FROM artifacts WHERE path = ${linker}`;
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // Confirm the link starts out as a redlink (literal slug).
    let linkRows = (await sql`
      SELECT target_path FROM links WHERE source_path = ${linker}
    `) as { target_path: string }[];
    expect(linkRows.map((r) => r.target_path)).toContain("late-arrival");

    // Now drop the target. The post-create resolver should rewrite
    // the link row to point at the full path.
    const target = "iarpa/late-arrival.md";
    writeFileSync(join(workdir, target), `# Late arrival\n`);
    deadline = Date.now() + 3000;
    let converged = false;
    while (Date.now() < deadline) {
      linkRows = (await sql`
        SELECT target_path FROM links WHERE source_path = ${linker}
      `) as { target_path: string }[];
      if (linkRows.some((r) => r.target_path === target)) {
        converged = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(converged).toBe(true);
  });

  it("POST /query rejects malformed JSON with 400 (not a silent unfiltered fallthrough)", async () => {
    // Footgun guard: c.req.json().catch(() => ({})) used to swallow
    // syntax errors and quietly return the full corpus. A harness with
    // a busted body builder would then happily reprocess everything.
    const res = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not { valid json",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_json");
  });

  it("POST /query rejects unknown top-level fields with 400", async () => {
    // Typo guard: `notag` ≠ `not_tag`. Silently ignoring the unknown
    // key would return the unfiltered corpus and the worker would
    // reprocess everything.
    const res = await app.fetch(
      new Request("http://test/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notag: ["processed-by-editor"] }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unknown_field");
    expect(body.error.message).toContain("notag");
  });

  it("POST /tag rejects unknown top-level fields with 400", async () => {
    const res = await app.fetch(
      new Request("http://test/tag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "iarpa/article.html",
          key: "k",
          extra: "nope",
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unknown_field");
  });

  it("POST /tag rejects keys containing ':' with 400 reserved_character", async () => {
    // The colon is the key/value separator in has_tag / not_tag specs.
    // A literal colon-key would store fine but then collide on read with
    // the (key, value) split, so reject up front.
    const res = await app.fetch(
      new Request("http://test/tag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "iarpa/article.html",
          key: "status:published",
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("reserved_character");
    expect(body.error.message).toContain(":");
  });

  it("POST /untag rejects keys containing ':' with 400 reserved_character", async () => {
    const res = await app.fetch(
      new Request("http://test/untag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "iarpa/article.html",
          key: "status:published",
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("reserved_character");
  });

  it("POST /query accepts an empty body (all-defaults query)", async () => {
    // Strict validation must not break the documented all-defaults call.
    const res = await app.fetch(
      new Request("http://test/query", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: unknown[] };
    expect(Array.isArray(body.artifacts)).toBe(true);
  });

  it("HTML href to a moved-between-folders file heals on disk + index", async () => {
    // Setup: inbound article references a sibling article via
    // `./moved-target.html`. The target lives one folder down at
    // `bf/sub/moved-target.html`. Doctrine: the watcher detects the
    // mismatch, the basename fallback finds the unique match, and
    // the SOURCE HTML on disk gets rewritten so its href spells
    // `sub/moved-target.html`. SQL converges naturally.
    mkdirSync(join(workdir, "bf/sub"), { recursive: true });
    writeFileSync(
      join(workdir, "bf/sub/moved-target.html"),
      `<!doctype html><html><head><title>Moved Target</title></head><body><p>moved</p></body></html>`,
    );
    writeFileSync(
      join(workdir, "bf/inbound.html"),
      `<!doctype html><html><head><title>Inbound</title></head><body>
         <a class="wikilink" href="./moved-target.html">moved</a>
       </body></html>`,
    );

    // Wait for both files to land AND for the inbound to reflect
    // the healed target (covers both arrival orders: target-first
    // heals during inbound's syncText; inbound-first heals during
    // the reresolve sweep triggered by target's create).
    const sql = createSql();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const arrived = (await sql`
        SELECT COUNT(*) AS n FROM artifacts
        WHERE path IN ('bf/inbound.html', 'bf/sub/moved-target.html')
      `) as { n: number }[];
      const linked = (await sql`
        SELECT target_path FROM links WHERE source_path = 'bf/inbound.html'
      `) as { target_path: string }[];
      if (
        (arrived[0]?.n ?? 0) === 2 &&
        linked.some((r) => r.target_path === "bf/sub/moved-target.html")
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    // Index-level convergence: the link row targets the moved
    // location, not the literal-resolved (and absent) path.
    const linkRows = (await sql`
      SELECT target_path FROM links WHERE source_path = 'bf/inbound.html'
    `) as { target_path: string }[];
    expect(linkRows.map((r) => r.target_path)).toContain(
      "bf/sub/moved-target.html",
    );

    // Doctrine assertion: the SOURCE file on disk has been edited so
    // the href spells the new relative path. View-source matches what
    // renders; the daemon doesn't lie at render time.
    const sourceOnDisk = readFileSync(
      join(workdir, "bf/inbound.html"),
      "utf-8",
    );
    expect(sourceOnDisk).toMatch(/href="sub\/moved-target\.html"/);
    expect(sourceOnDisk).not.toMatch(/href="\.\/moved-target\.html"/);

    // Backlinks convergence: the moved file's backlinks surface the
    // inbound article via the SQL link row.
    const back = await app.fetch(
      new Request("http://test/backlinks?path=bf/sub/moved-target.html"),
    );
    expect(back.status).toBe(200);
    const backBody = (await back.json()) as {
      backlinks: Array<{ source_path: string }>;
    };
    expect(backBody.backlinks.map((b) => b.source_path)).toContain(
      "bf/inbound.html",
    );

    // /redlinks does not surface the broken literal — the link row
    // got healed by the reresolve sweep (or by sync extraction).
    const red = await app.fetch(new Request("http://test/redlinks"));
    const redBody = (await red.json()) as {
      redlinks: Array<{ target_path: string }>;
    };
    expect(redBody.redlinks.map((r) => r.target_path)).not.toContain(
      "bf/moved-target.html",
    );

    // Reader is intentionally dumb-serve: the served HTML reflects
    // the file on disk, which now has the corrected href. No
    // render-time magic, no redlink class.
    const served = await app.fetch(
      new Request("http://test/bf/inbound.html"),
    );
    expect(served.status).toBe(200);
    const html = await served.text();
    expect(html).toMatch(/href="sub\/moved-target\.html"/);
    expect(html).not.toMatch(/wikilink[^"]*redlink/);
  });

  it("HTML href stays a redlink when basename is ambiguous (no silent guess)", async () => {
    // Two files share the same basename in different folders. The
    // inbound href can't be auto-healed because fallback has two
    // candidates. Doctrine consequence: no SQL rewrite, no file
    // edit, anchor surfaces as a redlink at render time.
    mkdirSync(join(workdir, "ambig/a"), { recursive: true });
    mkdirSync(join(workdir, "ambig/b"), { recursive: true });
    writeFileSync(
      join(workdir, "ambig/a/dup.html"),
      `<!doctype html><html><head><title>A dup</title></head><body>a</body></html>`,
    );
    writeFileSync(
      join(workdir, "ambig/b/dup.html"),
      `<!doctype html><html><head><title>B dup</title></head><body>b</body></html>`,
    );
    const inSrc = `<!doctype html><html><head><title>In</title></head><body>
         <a class="wikilink" href="./dup.html">dup</a>
       </body></html>`;
    writeFileSync(join(workdir, "ambig/in.html"), inSrc);

    const sql = createSql();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const rows = await sql`
        SELECT COUNT(*) AS n FROM artifacts
        WHERE path IN ('ambig/a/dup.html','ambig/b/dup.html','ambig/in.html')
      `;
      if ((rows[0] as { n: number }).n === 3) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // Link row points at the literal-resolved (missing) path —
    // ambiguous fallback is not taken.
    const linkRows = (await sql`
      SELECT target_path FROM links WHERE source_path = 'ambig/in.html'
    `) as { target_path: string }[];
    expect(linkRows.map((r) => r.target_path)).toContain("ambig/dup.html");

    // Source HTML on disk is untouched — no heal write happened.
    const sourceOnDisk = readFileSync(
      join(workdir, "ambig/in.html"),
      "utf-8",
    );
    expect(sourceOnDisk).toContain(`href="./dup.html"`);

    // Reader marks the anchor as a redlink (visible-broken).
    const served = await app.fetch(
      new Request("http://test/ambig/in.html"),
    );
    const html = await served.text();
    expect(html).toMatch(/class="wikilink redlink"/);
  });
});
