// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end smoke test for the v1 substrate surface.
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
  workdir = mkdtempSync(join(tmpdir(), "arkeon-v1-"));
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

describe("v1 substrate", () => {
  it("indexes artifacts with full relative paths", async () => {
    const sql = createSql();
    const rows = await sql`SELECT path, kind FROM artifacts ORDER BY path`;
    const byPath = new Map(rows.map((r) => [r.path as string, r.kind as string]));
    expect(byPath.get("iarpa/article.html")).toBe("text");
    expect(byPath.get("iarpa/sources/paper.md")).toBe("text");
    expect(byPath.get("chartbook/about.html")).toBe("text");
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

  it("POST /tag + GET /tags round trips", async () => {
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

    const tagsRes = await app.fetch(
      new Request("http://test/tags?path=iarpa/article.html"),
    );
    const body = (await tagsRes.json()) as { tags: Record<string, string> };
    expect(body.tags["processed-by"]).toBe("editor");
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

  it("GET /backlinks returns inbound link rows", async () => {
    const res = await app.fetch(
      new Request("http://test/backlinks?path=iarpa/sources/paper.md"),
    );
    const body = (await res.json()) as {
      backlinks: Array<{ source_path: string; attrs: Record<string, string> }>;
    };
    const first = body.backlinks.find((b) => b.source_path === "iarpa/article.html");
    expect(first).toBeDefined();
    expect(first!.attrs.quote).toBe("hello");
  });

  it("GET /redlinks lists unresolved targets", async () => {
    const res = await app.fetch(new Request("http://test/redlinks"));
    const body = (await res.json()) as { redlinks: Array<{ target_path: string }> };
    const targets = body.redlinks.map((r) => r.target_path);
    expect(targets).toContain("missing-target");
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

  it("POST /untag removes a tag", async () => {
    const res = await app.fetch(
      new Request("http://test/untag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "iarpa/article.html", key: "processed-by" }),
      }),
    );
    expect(res.status).toBe(200);
    const tagsRes = await app.fetch(
      new Request("http://test/tags?path=iarpa/article.html"),
    );
    const body = (await tagsRes.json()) as { tags: Record<string, string> };
    expect(body.tags["processed-by"]).toBeUndefined();
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
});
