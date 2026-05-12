// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end shape test for the v0 API surface.
 *
 * Boots a real arkeon-wiki API server against a fresh SQLite file +
 * tmp watch dir. Exercises the full happy path:
 *   - create space
 *   - watcher syncs HTML wikis + markdown source
 *   - GET /:space/entities returns path-keyed rows
 *   - GET /:space/entities/* fetches one with relationships
 *   - GET /:space/redlinks aggregates missing targets
 *   - GET /:space/recent surfaces the audit log
 *   - GET /:space/search ripgreps wiki bodies
 *   - chat routes return 501 (Phase 3 stub)
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

const SPACE = "phase1-demo";

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "arkeon-phase1-"));
  dbPath = join(workdir, "arke.db");

  mkdirSync(join(workdir, "wiki/biology"), { recursive: true });
  mkdirSync(join(workdir, "sources"), { recursive: true });

  writeFileSync(
    join(workdir, "wiki/photosynthesis.html"),
    `<!doctype html>
<title>Photosynthesis</title>
<meta name="label" content="Photosynthesis">
<meta name="short_description" content="How plants convert light into chemical energy.">
<body>
<h1>Photosynthesis</h1>
<p>Occurs inside <a href="../wiki/chloroplast.html">chloroplasts</a> and uses
<a href="biology/chlorophyll.html">chlorophyll</a>. See
<a href="../sources/shannon-1948.md">Shannon 1948</a> for the information-theory angle.</p>
</body>`,
  );
  writeFileSync(
    join(workdir, "wiki/biology/chlorophyll.html"),
    `<!doctype html>
<title>Chlorophyll</title>
<meta name="label" content="Chlorophyll">
<body><p>Found in chloroplasts.</p></body>`,
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

  await runMigrations({ dbPath });
  api = await startApi({ port: 0, dbPath });
  baseUrl = `http://localhost:${api.address.port}`;

  // Register the space; the daemon kicks off the watcher in the background.
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

describe("Phase 1 API shape", () => {
  it("GET /spaces lists the registered space", async () => {
    const res = await fetch(`${baseUrl}/spaces`);
    const body = (await res.json()) as { spaces: Array<{ name: string; entity_count: number }> };
    const space = body.spaces.find((s) => s.name === SPACE);
    expect(space).toBeDefined();
    expect(space!.entity_count).toBeGreaterThanOrEqual(3);
  });

  it("GET /:space/entities lists path-keyed entities with type filter", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/entities?type=wiki`);
    const body = (await res.json()) as { entities: Array<{ source_path: string; type: string; label: string }>; total: number };
    const paths = body.entities.map((e) => e.source_path);
    expect(paths).toContain("wiki/photosynthesis.html");
    expect(paths).toContain("wiki/biology/chlorophyll.html");
    expect(body.entities.every((e) => e.type === "wiki")).toBe(true);
  });

  it("GET /:space/entities supports inbound_max=0 to find unprocessed sources", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/entities?type=file&inbound_max=0&include=counts`);
    const body = (await res.json()) as { entities: Array<{ source_path: string; counts: { inbound: number } }> };
    // shannon-1948.md IS cited by photosynthesis.html, so it should not appear.
    expect(body.entities.find((e) => e.source_path === "sources/shannon-1948.md")).toBeUndefined();
  });

  it("GET /:space/entities/* returns a single entity with relationships", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/entities/wiki/photosynthesis.html`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source_path: string;
      label: string;
      properties: Record<string, unknown>;
      outbound: Array<{ target_path: string }>;
      inbound: Array<{ source_path: string }>;
    };
    expect(body.source_path).toBe("wiki/photosynthesis.html");
    expect(body.label).toBe("Photosynthesis");
    expect(body.properties.short_description).toBe(
      "How plants convert light into chemical energy.",
    );
    const targets = body.outbound.map((r) => r.target_path).sort();
    expect(targets).toEqual([
      "sources/shannon-1948.md",
      "wiki/biology/chlorophyll.html",
      "wiki/chloroplast.html",
    ]);
  });

  it("GET /:space/entities/* with include=content returns file body", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/entities/wiki/biology/chlorophyll.html?include=content`);
    const body = (await res.json()) as { content: string };
    expect(body.content).toContain("<title>Chlorophyll</title>");
  });

  it("GET /:space/redlinks lists targets with no entity yet", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/redlinks`);
    const body = (await res.json()) as {
      redlinks: Array<{ target_path: string; demand: number; linked_from: string[] }>;
    };
    const chloroplast = body.redlinks.find((r) => r.target_path === "wiki/chloroplast.html");
    expect(chloroplast).toBeDefined();
    expect(chloroplast!.demand).toBe(1);
    expect(chloroplast!.linked_from).toContain("wiki/photosynthesis.html");
  });

  it("GET /:space/recent surfaces the entity_edits feed", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/recent?limit=10`);
    const body = (await res.json()) as { space: string; edits: Array<{ entity_path: string; by_role: string }> };
    expect(body.space).toBe(SPACE);
    expect(body.edits.length).toBeGreaterThan(0);
    // Watcher-driven syncs attribute to "human" (no agent edit-context registered).
    expect(body.edits.every((e) => e.by_role === "human")).toBe(true);
  });

  it("GET /:space/search ripgreps wiki bodies", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/search?q=chloroplast`);
    const body = (await res.json()) as {
      keyword: { hits: Array<{ source_path: string; match_count: number }>; total: number };
    };
    expect(body.keyword.total).toBeGreaterThan(0);
    expect(body.keyword.hits.some((h) => h.source_path === "wiki/photosynthesis.html")).toBe(true);
  });

  it("POST /:space/chat returns 501 (Phase 3 stub)", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_implemented");
  });

  it("404s an unknown space cleanly", async () => {
    const res = await fetch(`${baseUrl}/nonexistent/entities`);
    expect(res.status).toBe(404);
  });

  it("POST /spaces returns 409 on duplicate name (PK constraint → mapDatabaseError)", async () => {
    const res = await fetch(`${baseUrl}/spaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: SPACE, watch_dir: "/tmp/some-other-dir" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("conflict");
  });

  it("POST /spaces rejects names with slashes / dots / spaces", async () => {
    const badNames = ["foo/bar", "..", "../escape", "with space", "#hash", "?query", ".hidden"];
    for (const name of badNames) {
      const res = await fetch(`${baseUrl}/spaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, watch_dir: "/tmp/x" }),
      });
      expect(res.status, `expected 400 for name ${JSON.stringify(name)}`).toBe(400);
    }
  });

  it("POST /spaces rejects names over 100 chars", async () => {
    const res = await fetch(`${baseUrl}/spaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "a".repeat(101), watch_dir: "/tmp/x" }),
    });
    expect(res.status).toBe(400);
  });
});
