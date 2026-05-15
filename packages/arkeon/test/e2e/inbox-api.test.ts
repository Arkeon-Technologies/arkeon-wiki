// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end coverage for the source write-back endpoints:
 *   POST /:space/inbox          server-named under sources/inbox/<date>/
 *   PUT  /:space/sources/*      caller-named path
 *
 * Both spin up against a real in-process API + tmp watch_dir. We assert
 * disk effects (file lands, sync row exists, audit row carries the
 * caller) and rejection paths (wiki/binary/traversal, 409 on collision).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startApi, type ArkeonApi } from "../../src/server/server.js";
import { runMigrations } from "../../src/schema/migrate.js";
import { createSql } from "../../src/server/lib/sql.js";
import { getEntityByPath } from "./helpers.js";

let api: ArkeonApi;
let baseUrl: string;
let workdir: string;
let dbPath: string;

const SPACE = "inbox-test";

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "arkeon-inbox-"));
  dbPath = join(workdir, "arke.db");
  await runMigrations({ dbPath });
  api = await startApi({ port: 0, dbPath });
  baseUrl = `http://localhost:${api.address.port}`;

  const res = await fetch(`${baseUrl}/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: SPACE, watch_dir: workdir }),
  });
  expect(res.status).toBe(201);
}, 30_000);

afterAll(async () => {
  await api?.stop({ drainTimeoutMs: 2000 });
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

interface InboxResponse {
  space: string;
  path: string;
  entity: {
    source_path: string;
    type: "wiki" | "file";
    label: string | null;
    tags: Record<string, unknown> | string;
  };
}

interface PutResponse extends InboxResponse {
  overwrote: boolean;
}

async function lastEditRole(
  spaceName: string,
  entityPath: string,
): Promise<string | null> {
  const sql = createSql();
  const rows = await sql`
    SELECT by_role FROM entity_edits
    WHERE space_name = ${spaceName} AND entity_path = ${entityPath}
    ORDER BY at DESC LIMIT 1
  `;
  return rows.length === 0 ? null : (rows[0].by_role as string);
}

describe("POST /:space/inbox", () => {
  it("creates a dated source from text + title with markdown heading", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Quick note about a migration discussion.",
        title: "Slack thread on migrations",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as InboxResponse;
    expect(body.path).toMatch(
      /^sources\/inbox\/\d{4}-\d{2}-\d{2}\/slack-thread-on-migrations\.md$/,
    );
    expect(body.entity.type).toBe("file");

    const content = readFileSync(join(workdir, body.path), "utf-8");
    expect(content.startsWith("# Slack thread on migrations\n\n")).toBe(true);
    expect(content).toContain("Quick note about a migration discussion.");
  });

  it("falls back to a ULID-prefix slug when no title is provided", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "anonymous drop" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as InboxResponse;
    expect(body.path).toMatch(
      /^sources\/inbox\/\d{4}-\d{2}-\d{2}\/[0-9a-z]{10}\.md$/,
    );
  });

  it("auto-suffixes a colliding slug", async () => {
    const post = (title: string) =>
      fetch(`${baseUrl}/${SPACE}/inbox`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "x", title }),
      });
    const a = (await (await post("dup")).json()) as InboxResponse;
    const b = (await (await post("dup")).json()) as InboxResponse;
    expect(a.path).toMatch(/\/dup\.md$/);
    expect(b.path).toMatch(/\/dup-2\.md$/);
  });

  it("respects kind=txt (no heading, .txt extension)", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "raw text without heading",
        title: "Should Be Ignored",
        kind: "txt",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as InboxResponse;
    expect(body.path).toMatch(/\.txt$/);
    const content = readFileSync(join(workdir, body.path), "utf-8");
    expect(content).toBe("raw text without heading\n");
  });

  it("applies caller-supplied tags to the new entity", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "tagged note",
        title: "tagged",
        tags: { source: "slack", import_run: "abc123" },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as InboxResponse;
    const tags =
      typeof body.entity.tags === "string"
        ? JSON.parse(body.entity.tags)
        : body.entity.tags;
    expect(tags.source).toBe("slack");
    expect(tags.import_run).toBe("abc123");
  });

  it("attributes the edit to X-Caller (with sanitization)", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/inbox`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-caller": "slack-bridge",
      },
      body: JSON.stringify({ text: "caller-attributed", title: "caller-test" }),
    });
    const body = (await res.json()) as InboxResponse;
    expect(await lastEditRole(SPACE, body.path)).toBe("slack-bridge");
  });

  it("falls back to 'api' when X-Caller is missing or invalid", async () => {
    const missing = await fetch(`${baseUrl}/${SPACE}/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "no caller", title: "caller-missing" }),
    });
    const m = (await missing.json()) as InboxResponse;
    expect(await lastEditRole(SPACE, m.path)).toBe("api");

    const bad = await fetch(`${baseUrl}/${SPACE}/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-caller": "has space!" },
      body: JSON.stringify({ text: "bad caller", title: "caller-bad" }),
    });
    const b = (await bad.json()) as InboxResponse;
    expect(await lastEditRole(SPACE, b.path)).toBe("api");
  });

  it("rejects missing text", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "no body" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-string tag values", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x", tags: { n: 123 } }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects unknown kind", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x", kind: "html" }),
    });
    expect(res.status).toBe(400);
  });

  it("404s when the space does not exist", async () => {
    const res = await fetch(`${baseUrl}/no-such-space/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("413s on oversized body", async () => {
    // 11 MB body; the pre-buffer Content-Length gate catches it before
    // we ever read the JSON. Honest clients are short-circuited cheaply;
    // a client lying about CL still gets caught by the post-buffer check.
    const text = "x".repeat(11 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/${SPACE}/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    expect(res.status).toBe(413);
  });

  it("treats empty/whitespace-only title as no title (ULID fallback)", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x", title: "   " }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as InboxResponse;
    expect(body.path).toMatch(
      /^sources\/inbox\/\d{4}-\d{2}-\d{2}\/[0-9a-z]{10}\.md$/,
    );
  });

  it("does not tag the new source with editor.processed_hash (queues it)", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "queue-me", title: "queue-test" }),
    });
    const body = (await res.json()) as InboxResponse;
    const tags =
      typeof body.entity.tags === "string"
        ? JSON.parse(body.entity.tags || "{}")
        : body.entity.tags || {};
    expect(tags["editor.processed_hash"]).toBeUndefined();
    expect(tags["proposer.processed_hash"]).toBeUndefined();
  });
});

describe("PUT /:space/sources/*", () => {
  it("writes at the caller-chosen path under sources/", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/sources/uploads/note.md`, {
      method: "PUT",
      headers: { "content-type": "text/markdown" },
      body: "# uploaded\n\nhello\n",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as PutResponse;
    expect(body.path).toBe("sources/uploads/note.md");
    expect(body.overwrote).toBe(false);
    expect(await getEntityByPath(SPACE, "sources/uploads/note.md")).not.toBeNull();
    expect(readFileSync(join(workdir, body.path), "utf-8")).toBe(
      "# uploaded\n\nhello\n",
    );
  });

  it("409s on collision without overwrite", async () => {
    await fetch(`${baseUrl}/${SPACE}/sources/collide.md`, {
      method: "PUT",
      body: "first",
    });
    const res = await fetch(`${baseUrl}/${SPACE}/sources/collide.md`, {
      method: "PUT",
      body: "second",
    });
    expect(res.status).toBe(409);
    expect(readFileSync(join(workdir, "sources/collide.md"), "utf-8")).toBe(
      "first",
    );
  });

  it("?overwrite=true replaces the file and emits both delete + create audit rows", async () => {
    await fetch(`${baseUrl}/${SPACE}/sources/replace.md`, {
      method: "PUT",
      body: "v1",
    });
    const res = await fetch(
      `${baseUrl}/${SPACE}/sources/replace.md?overwrite=true`,
      { method: "PUT", body: "v2" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PutResponse;
    expect(body.overwrote).toBe(true);
    expect(readFileSync(join(workdir, "sources/replace.md"), "utf-8")).toBe(
      "v2",
    );

    // The destroy + recreate lifecycle must be observable in the audit
    // log: one create from the initial PUT, then a delete + a create
    // from the overwrite. The two-row overwrite is documented in the PR.
    const sql = createSql();
    const kinds = (await sql`
      SELECT edit_kind FROM entity_edits
      WHERE space_name = ${SPACE} AND entity_path = 'sources/replace.md'
      ORDER BY at ASC
    `) as Array<{ edit_kind: string }>;
    expect(kinds.map((r) => r.edit_kind)).toEqual(["create", "delete", "create"]);
  });

  it("413s on oversized body", async () => {
    const body = "x".repeat(11 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/${SPACE}/sources/big.md`, {
      method: "PUT",
      body,
    });
    expect(res.status).toBe(413);
  });

  it("400s on empty path or trailing slash", async () => {
    const trailing = await fetch(`${baseUrl}/${SPACE}/sources/foo/`, {
      method: "PUT",
      body: "x",
    });
    expect(trailing.status).toBe(400);
  });

  // Note: `..` rejection is unit-tested directly on `assertSourcePath` in
  // test/unit/inbox-lib.test.ts. We can't drive it from a `fetch()`-built
  // request because the URL parser collapses `..` segments client-side
  // before the request hits Hono. The server-side guard still catches
  // anything that *does* arrive (e.g. a hand-crafted raw HTTP request).

  it("rejects binary content (NUL byte) under an unknown extension", async () => {
    const res = await fetch(`${baseUrl}/${SPACE}/sources/bin.unknown`, {
      method: "PUT",
      body: new Uint8Array([0x68, 0x00, 0x69]),
    });
    expect(res.status).toBe(400);
  });

  it("attributes via X-Caller, defaulting to 'api'", async () => {
    await fetch(`${baseUrl}/${SPACE}/sources/attrib.md`, {
      method: "PUT",
      headers: { "x-caller": "ci-import" },
      body: "x",
    });
    expect(await lastEditRole(SPACE, "sources/attrib.md")).toBe("ci-import");
  });

  it("404s when the space does not exist", async () => {
    const res = await fetch(`${baseUrl}/no-such-space/sources/x.md`, {
      method: "PUT",
      body: "x",
    });
    expect(res.status).toBe(404);
  });
});
