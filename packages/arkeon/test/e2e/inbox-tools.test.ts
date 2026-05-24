// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2e coverage for the `inbox` and `add_source` agent tools.
 *
 * Both tools write under `sources/inbox/<date>/` and rely on the watcher's
 * classifier to put the resulting entity row in the right `kind`. These
 * tests boot the runtime directly (no HTTP API needed for the tools) and
 * stand up a small in-process HTTP server to serve fixture bytes for
 * `add_source`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { runMigrations } from "../../src/schema/migrate.js";
import { closeDb, createSql, initDb } from "../../src/server/lib/sql.js";
import { type Space } from "../../src/server/lib/sync.js";
import { ALL_TOOLS } from "../../src/server/agents/tools.js";
import { makeContext } from "../../src/server/agents/runtime.js";
import type { Tool } from "ai";

let workdir: string;
let dbPath: string;
let fixtureServer: Server;
let fixtureBaseUrl: string;
const SPACE: Space = { name: "tools-test", watch_dir: "" };

const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n%\xC7\xEC\x8F\xA2\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "binary",
);

const HTML_BYTES = Buffer.from(
  "<!doctype html><meta charset=utf-8><title>Fixture article</title><body><h1>Fixture</h1><p>Body.</p></body>",
);

async function startFixtureServer(): Promise<{
  server: Server;
  baseUrl: string;
}> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/paper.pdf") {
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": String(PDF_BYTES.byteLength),
      });
      res.end(PDF_BYTES);
      return;
    }
    if (url.pathname === "/article.html") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(HTML_BYTES.byteLength),
      });
      res.end(HTML_BYTES);
      return;
    }
    if (url.pathname === "/download") {
      // Content-Disposition path
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="Augustine on Grief.pdf"',
      });
      res.end(PDF_BYTES);
      return;
    }
    if (url.pathname === "/bad") {
      res.writeHead(500);
      res.end("nope");
      return;
    }
    if (url.pathname === "/installer.dmg") {
      res.writeHead(200, {
        "content-type": "application/x-apple-diskimage",
      });
      res.end(Buffer.from([0x00, 0x01, 0x02]));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

beforeEach(async () => {
  workdir = mkdtempSync(join(tmpdir(), "arkeon-tools-"));
  dbPath = join(workdir, "arke.db");
  SPACE.watch_dir = workdir;
  mkdirSync(join(workdir, "sources"), { recursive: true });

  await runMigrations({ dbPath });
  initDb(dbPath);
  const sql = createSql();
  await sql`INSERT INTO spaces(name, watch_dir) VALUES(${SPACE.name}, ${workdir})`;

  const fx = await startFixtureServer();
  fixtureServer = fx.server;
  fixtureBaseUrl = fx.baseUrl;
});

afterEach(async () => {
  closeDb();
  await new Promise<void>((resolve, reject) =>
    fixtureServer.close((err) => (err ? reject(err) : resolve())),
  );
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

function getTool(name: string, ctx: ReturnType<typeof makeContext>): Tool {
  const factory = ALL_TOOLS[name];
  if (!factory) throw new Error(`unknown tool: ${name}`);
  return factory(ctx);
}

async function execTool<T = unknown>(tool: Tool, input: unknown): Promise<T> {
  type Exec = (
    input: unknown,
    ctx: { toolCallId: string; messages: unknown[] },
  ) => Promise<T>;
  const fn = (tool as unknown as { execute: Exec }).execute;
  return fn(input, { toolCallId: "test", messages: [] });
}

describe("inbox tool", () => {
  it("writes md with title heading under sources/inbox/<date>/", async () => {
    const ctx = makeContext(SPACE, "editor");
    const inbox = getTool("inbox", ctx);
    const result = (await execTool(inbox, {
      text: "We keep seeing X across migrations sources.",
      title: "Migrations theme",
    })) as { path: string; entity: { type: string; label: string | null } };

    expect(result.path).toMatch(
      /^sources\/inbox\/\d{4}-\d{2}-\d{2}\/migrations-theme\.md$/,
    );
    const body = readFileSync(join(workdir, result.path), "utf-8");
    expect(body.startsWith("# Migrations theme\n\n")).toBe(true);
    expect(body).toContain("We keep seeing X");
    expect(result.entity.type).toBe("file");
  });

  it("falls back to ULID-prefixed filename when title omitted", async () => {
    const ctx = makeContext(SPACE, "editor");
    const inbox = getTool("inbox", ctx);
    const result = (await execTool(inbox, {
      text: "raw thought",
    })) as { path: string };
    expect(result.path).toMatch(
      /^sources\/inbox\/\d{4}-\d{2}-\d{2}\/[0-9a-z]{10}\.md$/,
    );
  });

  it("writes verbatim txt when kind=txt", async () => {
    const ctx = makeContext(SPACE, "editor");
    const inbox = getTool("inbox", ctx);
    const result = (await execTool(inbox, {
      text: "verbatim line",
      title: "raw note",
      kind: "txt",
    })) as { path: string };
    expect(result.path).toMatch(/\/raw-note\.txt$/);
    const body = readFileSync(join(workdir, result.path), "utf-8");
    expect(body).toBe("verbatim line\n");
  });

  it("records the agent role in entity_edits.by_role", async () => {
    const ctx = makeContext(SPACE, "proposer");
    const inbox = getTool("inbox", ctx);
    const result = (await execTool(inbox, {
      text: "from the proposer",
      title: "proposer note",
    })) as { path: string };
    const sql = createSql();
    const rows = (await sql`
      SELECT by_role FROM entity_edits
      WHERE space_name = ${SPACE.name} AND entity_path = ${result.path}
      ORDER BY at DESC LIMIT 1
    `) as Array<{ by_role: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].by_role).toBe("proposer");
  });
});

describe("add_source tool", () => {
  it("downloads HTML and lands it as kind='text'", async () => {
    const ctx = makeContext(SPACE, "proposer");
    const tool = getTool("add_source", ctx);
    const result = (await execTool(tool, {
      url: `${fixtureBaseUrl}/article.html`,
    })) as {
      path: string;
      media_type: string;
      size_bytes: number;
      entity: { type: string; properties: Record<string, unknown> | string };
    };

    expect(result.path).toMatch(
      /^sources\/inbox\/\d{4}-\d{2}-\d{2}\/article\.html$/,
    );
    expect(result.media_type).toBe("text/html");
    expect(result.size_bytes).toBe(HTML_BYTES.byteLength);
    expect(existsSync(join(workdir, result.path))).toBe(true);

    // Sync classified it as a text-kind file (HTML lands as a wiki only
    // under wiki/; here it's a source under sources/, so type=file).
    const sql = createSql();
    const rows = (await sql`
      SELECT type, kind FROM entities
      WHERE space_name = ${SPACE.name} AND source_path = ${result.path}
    `) as Array<{ type: string; kind: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("file");
    expect(rows[0].kind).toBe("text");
  });

  it("downloads PDF and lands it as kind='asset'", async () => {
    const ctx = makeContext(SPACE, "proposer");
    const tool = getTool("add_source", ctx);
    const result = (await execTool(tool, {
      url: `${fixtureBaseUrl}/paper.pdf`,
    })) as { path: string; media_type: string };

    expect(result.path).toMatch(
      /^sources\/inbox\/\d{4}-\d{2}-\d{2}\/paper\.pdf$/,
    );
    expect(result.media_type).toBe("application/pdf");
    // Bytes match exactly — no encoding mangling on the binary write path.
    expect(readFileSync(join(workdir, result.path)).equals(PDF_BYTES)).toBe(
      true,
    );

    const sql = createSql();
    const rows = (await sql`
      SELECT kind FROM entities
      WHERE space_name = ${SPACE.name} AND source_path = ${result.path}
    `) as Array<{ kind: string }>;
    expect(rows[0].kind).toBe("asset");
  });

  it("prefers Content-Disposition filename when present", async () => {
    const ctx = makeContext(SPACE, "proposer");
    const tool = getTool("add_source", ctx);
    const result = (await execTool(tool, {
      url: `${fixtureBaseUrl}/download`,
    })) as { path: string };
    expect(result.path).toMatch(/\/augustine-on-grief\.pdf$/);
  });

  it("returns an error for unsupported media types", async () => {
    const ctx = makeContext(SPACE, "proposer");
    const tool = getTool("add_source", ctx);
    const result = (await execTool(tool, {
      url: `${fixtureBaseUrl}/installer.dmg`,
    })) as { error?: string };
    expect(result.error).toMatch(/unsupported_media_type/);
  });

  it("returns an error for HTTP failures", async () => {
    const ctx = makeContext(SPACE, "proposer");
    const tool = getTool("add_source", ctx);
    const result = (await execTool(tool, {
      url: `${fixtureBaseUrl}/bad`,
    })) as { error?: string };
    expect(result.error).toMatch(/HTTP 500/);
  });

  it("returns an error for non-http(s) URLs", async () => {
    const ctx = makeContext(SPACE, "proposer");
    const tool = getTool("add_source", ctx);
    const result = (await execTool(tool, {
      url: "file:///etc/passwd",
    })) as { error?: string };
    expect(result.error).toMatch(/http:\/\/ or https:\/\//);
  });

  it("auto-suffixes on filename collision", async () => {
    const ctx = makeContext(SPACE, "proposer");
    const tool = getTool("add_source", ctx);
    const url = `${fixtureBaseUrl}/article.html`;
    const first = (await execTool(tool, { url })) as { path: string };
    const second = (await execTool(tool, { url })) as { path: string };
    expect(first.path).toMatch(/\/article\.html$/);
    expect(second.path).toMatch(/\/article-2\.html$/);
  });

  it("respects the operator kill switch", async () => {
    const prior = process.env.ARKEON_WIKI_FETCH_DISABLED;
    process.env.ARKEON_WIKI_FETCH_DISABLED = "1";
    try {
      const ctx = makeContext(SPACE, "proposer");
      const tool = getTool("add_source", ctx);
      const result = (await execTool(tool, {
        url: `${fixtureBaseUrl}/article.html`,
      })) as { error?: string };
      expect(result.error).toMatch(/disabled by operator/);
    } finally {
      if (prior === undefined) delete process.env.ARKEON_WIKI_FETCH_DISABLED;
      else process.env.ARKEON_WIKI_FETCH_DISABLED = prior;
    }
  });
});
