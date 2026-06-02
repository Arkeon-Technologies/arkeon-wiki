// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end smoke test for the substrate surface.
 *
 * Spins up the API in-process against a temp watched root, lets the
 * watcher reconcile, then exercises the six commands plus the reader.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, createSql, initDb } from "../../src/server/lib/sql.js";
import { runMigrations } from "../../src/schema/migrate.js";
import { startWatching, stopWatching } from "../../src/server/lib/fs-watcher.js";
import { createApp } from "../../src/server/app.js";

let workdir: string;
let app: ReturnType<typeof createApp>;

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

  await startWatching(workdir);
  app = createApp();
});

afterAll(async () => {
  await stopWatching();
  closeDb();
  rmSync(workdir, { recursive: true, force: true });
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

  it("GET /<file> rewrites wikilinks and marks unresolved as redlinks", async () => {
    const res = await app.fetch(new Request("http://test/iarpa/article.html"));
    expect(res.status).toBe(200);
    const text = await res.text();
    // The resolved wikilink still carries its class, no redlink.
    expect(text).toContain(`class="wikilink"`);
    expect(text).not.toMatch(/wikilink[^"]*redlink/);
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
});
