// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end tests for the Phase 2 reader routes:
 *
 *   GET /                     spaces list HTML
 *   GET /:space               301 → /:space/
 *   GET /:space/              article index HTML
 *   GET /:space/wiki/*        instrumented wiki HTML
 *   GET /:space/*             raw static-file passthrough
 *
 * Boots a real arkeon-wiki API, registers a space, waits for the
 * watcher to sync a small corpus, then exercises each route.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startApi, type ArkeonApi } from "../../src/server/server.js";
import { runMigrations } from "../../src/schema/migrate.js";
import { waitForEntity } from "./helpers.js";

let api: ArkeonApi;
let baseUrl: string;
let workdir: string;
let dbPath: string;

const SPACE = "reader-demo";

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "arkeon-reader-"));
  dbPath = join(workdir, "arke.db");

  mkdirSync(join(workdir, "wiki/biology"), { recursive: true });
  mkdirSync(join(workdir, "sources"), { recursive: true });
  mkdirSync(join(workdir, "images"), { recursive: true });

  writeFileSync(
    join(workdir, "wiki/photosynthesis.html"),
    `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Photosynthesis</title>
<meta name="label" content="Photosynthesis">
<meta name="short_description" content="How plants convert light into chemical energy.">
</head>
<body>
<h1>Photosynthesis</h1>
<p>Occurs inside <a href="biology/chlorophyll.html">chloroplasts</a> and references
<a href="ghost-article.html">a missing article</a>.</p>
<p>See <a href="../sources/shannon-1948.md">Shannon 1948</a> and
<a href="../sources/missing.md">a missing source</a> and
<a href="https://wikipedia.org">wikipedia</a>.</p>
</body>
</html>`,
  );

  writeFileSync(
    join(workdir, "wiki/biology/chlorophyll.html"),
    `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Chlorophyll</title>
<meta name="label" content="Chlorophyll"></head>
<body><h1>Chlorophyll</h1><p>Found in chloroplasts.</p></body>
</html>`,
  );

  writeFileSync(
    join(workdir, "sources/shannon-1948.md"),
    `---
year: 1948
author: Shannon
---

A mathematical theory of communication.
`,
  );

  writeFileSync(
    join(workdir, "images/diagram.txt"),
    "pretend this is a binary image",
  );

  await runMigrations({ dbPath });
  api = await startApi({ port: 0, dbPath });
  baseUrl = `http://localhost:${api.address.port}`;

  const res = await fetch(`${baseUrl}/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: SPACE, watch_dir: workdir }),
  });
  expect(res.status).toBe(201);

  await waitForEntity(SPACE, "wiki/photosynthesis.html");
  await waitForEntity(SPACE, "wiki/biology/chlorophyll.html");
  await waitForEntity(SPACE, "sources/shannon-1948.md");
}, 30_000);

afterAll(async () => {
  await api?.stop({ drainTimeoutMs: 2000 });
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe("Phase 2 reader", () => {
  it("GET / returns an HTML list of spaces", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("<title>arkeon-wiki</title>");
    expect(body).toContain(`<a href="/${SPACE}/">${SPACE}</a>`);
  });

  it("GET /:space (no trailing slash) 301-redirects to /:space/", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`/${SPACE}/`);
  });

  it("GET /:space/ returns an alphabetical article index", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain(`<title>${SPACE} — arkeon-wiki</title>`);
    expect(body).toContain(
      `<a href="/${SPACE}/wiki/biology/chlorophyll.html">Chlorophyll</a>`,
    );
    expect(body).toContain(
      `<a href="/${SPACE}/wiki/photosynthesis.html">Photosynthesis</a>`,
    );
    expect(body).toContain("How plants convert light into chemical energy.");

    const choIdx = body.indexOf(">Chlorophyll<");
    const phoIdx = body.indexOf(">Photosynthesis<");
    expect(choIdx).toBeLessThan(phoIdx); // alphabetical
  });

  it("GET /:space/wiki/* returns the article with chrome and link classes", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/wiki/photosynthesis.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();

    // Chrome injected
    expect(body).toContain(`<div id="arkeon-chrome">`);
    expect(body).toContain(`href="/${SPACE}/"`);
    expect(body).toContain(`<style data-arkeon-chrome>`);

    // Article body preserved
    expect(body).toContain("<h1>Photosynthesis</h1>");

    // Existing wiki link → arkeon-wiki only
    expect(body).toContain(
      `<a href="biology/chlorophyll.html" class="arkeon-wiki">`,
    );
    // Missing wiki → arkeon-wiki + arkeon-redlink
    expect(body).toContain(
      `<a href="ghost-article.html" class="arkeon-wiki arkeon-redlink">`,
    );
    // Existing source → arkeon-file
    expect(body).toContain(
      `<a href="../sources/shannon-1948.md" class="arkeon-file">`,
    );
    // Missing source → arkeon-file + arkeon-redlink
    expect(body).toContain(
      `<a href="../sources/missing.md" class="arkeon-file arkeon-redlink">`,
    );
    // External link untouched
    expect(body).toContain(`<a href="https://wikipedia.org">wikipedia</a>`);
  });

  it("GET /:space/sources/*.md serves markdown raw with text/markdown content-type", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/sources/shannon-1948.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/markdown/);
    const body = await res.text();
    expect(body).toContain("A mathematical theory of communication.");
    // No chrome injection for non-wiki paths.
    expect(body).not.toContain("arkeon-chrome");
  });

  it("GET /:space/wiki/*.html for a missing path returns 404 HTML", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/wiki/no-such-article.html`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("not found");
  });

  it("GET /:space/wiki/* refuses path-traversal escapes", async () => {
    // /etc/passwd via ../../.. — must not serve anything outside watch_dir.
    const res = await fetch(
      `${baseUrl}/${SPACE}/wiki/../../../../etc/passwd`,
    );
    // node-fetch / undici may normalize `..` before the request; either
    // way we should never get a 200 with /etc/passwd content.
    expect(res.status === 404 || res.status === 400).toBe(true);
    if (res.status === 200) {
      const body = await res.text();
      expect(body).not.toContain("root:");
    }
  });

  it("GET /:space/<missing> returns 404 (not a 500)", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/sources/totally-missing.md`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("GET /:space/ for an unknown space returns 404", async () => {
    const res = await fetch(`${baseUrl}/no-such-space/`);
    expect(res.status).toBe(404);
  });

  it("reader does not shadow the API routes", async () => {
    // /:space/entities, /:space/redlinks etc. must still return JSON,
    // not get gobbled by the static-file fallback.
    const entities = await fetch(`${baseUrl}/${SPACE}/entities?type=wiki`);
    expect(entities.status).toBe(200);
    expect(entities.headers.get("content-type")).toMatch(/application\/json/);

    const redlinks = await fetch(`${baseUrl}/${SPACE}/redlinks`);
    expect(redlinks.status).toBe(200);
    expect(redlinks.headers.get("content-type")).toMatch(/application\/json/);

    const recent = await fetch(`${baseUrl}/${SPACE}/recent`);
    expect(recent.status).toBe(200);

    const search = await fetch(`${baseUrl}/${SPACE}/search?q=chloroplast`);
    expect(search.status).toBe(200);
  });

  it("daemon-level routes still respond as JSON", async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("content-type")).toMatch(/application\/json/);

    const spaces = await fetch(`${baseUrl}/spaces`);
    expect(spaces.status).toBe(200);
    expect(spaces.headers.get("content-type")).toMatch(/application\/json/);
  });
});
