// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2e coverage for `POST /:space/sources/from-url`, the HTTP analogue of
 * the `add_source` agent tool. The endpoint is the MCP server's path
 * into the corpus, replacing the WebFetch-then-POST-/inbox pattern.
 *
 * We stand up a real API + a fixture HTTP server to serve test bytes
 * (PDF, HTML, an unsupported binary). The assertions are about the
 * disk effect (file lands at the right path with the right bytes), the
 * sync (entity row gets the right kind), and the error shape (415 / 502
 * / 503 / 400) so callers can branch on it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { startApi, type ArkeonApi } from "../../src/server/server.js";
import { runMigrations } from "../../src/schema/migrate.js";
import { createSql } from "../../src/server/lib/sql.js";

let api: ArkeonApi;
let baseUrl: string;
let workdir: string;
let dbPath: string;
let fixtureServer: Server;
let fixtureBaseUrl: string;

const SPACE = "from-url-test";

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

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "arkeon-from-url-"));
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

  const fx = await startFixtureServer();
  fixtureServer = fx.server;
  fixtureBaseUrl = fx.baseUrl;
}, 30_000);

afterAll(async () => {
  await api?.stop({ drainTimeoutMs: 2000 });
  await new Promise<void>((resolve, reject) =>
    fixtureServer.close((err) => (err ? reject(err) : resolve())),
  );
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

interface FromUrlResponse {
  space: string;
  path: string;
  url: string;
  media_type: string;
  size_bytes: number;
  entity: {
    type: "wiki" | "file";
    kind: "text" | "asset";
    source_path: string;
  };
}

async function postFromUrl(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/${SPACE}/sources/from-url`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("daemon bind posture", () => {
  it("binds to 127.0.0.1 by default — not all interfaces", () => {
    // The from-url endpoint is an SSRF gadget for anything that can
    // reach the daemon (no auth, fetches arbitrary HTTPS URLs from the
    // daemon's network position, persists the bytes). Loopback-only by
    // default is the safe posture; `ARKEON_WIKI_HOST` is the opt-in
    // override for operators who deliberately want a shared daemon.
    expect(api.address.address).toBe("127.0.0.1");
  });
});

describe("POST /:space/sources/from-url", () => {
  it("downloads HTML, lands kind='text', returns the synced entity", async () => {
    const res = await postFromUrl({ url: `${fixtureBaseUrl}/article.html` });
    expect(res.status).toBe(201);
    const body = (await res.json()) as FromUrlResponse;
    expect(body.path).toMatch(
      /^sources\/inbox\/\d{4}-\d{2}-\d{2}\/article\.html$/,
    );
    expect(body.media_type).toBe("text/html");
    expect(body.size_bytes).toBe(HTML_BYTES.byteLength);
    expect(body.entity.kind).toBe("text");
    expect(readFileSync(join(workdir, body.path)).equals(HTML_BYTES)).toBe(true);
  });

  it("downloads PDF and lands kind='asset' (bytes byte-identical)", async () => {
    const res = await postFromUrl({ url: `${fixtureBaseUrl}/paper.pdf` });
    expect(res.status).toBe(201);
    const body = (await res.json()) as FromUrlResponse;
    expect(body.path).toMatch(
      /^sources\/inbox\/\d{4}-\d{2}-\d{2}\/paper\.pdf$/,
    );
    expect(body.media_type).toBe("application/pdf");
    expect(body.entity.kind).toBe("asset");
    expect(readFileSync(join(workdir, body.path)).equals(PDF_BYTES)).toBe(true);
  });

  it("prefers Content-Disposition filename when present", async () => {
    const res = await postFromUrl({ url: `${fixtureBaseUrl}/download` });
    expect(res.status).toBe(201);
    const body = (await res.json()) as FromUrlResponse;
    expect(body.path).toMatch(/\/augustine-on-grief\.pdf$/);
  });

  it("auto-suffixes on filename collision", async () => {
    const url = `${fixtureBaseUrl}/article.html`;
    const a = (await (await postFromUrl({ url })).json()) as FromUrlResponse;
    const b = (await (await postFromUrl({ url })).json()) as FromUrlResponse;
    // The first request in the earlier test already landed `article.html`,
    // so this pair lands at `article-N.html` / `article-(N+1).html`.
    const aMatch = /article(?:-(\d+))?\.html$/.exec(a.path);
    const bMatch = /article-(\d+)\.html$/.exec(b.path);
    expect(aMatch).not.toBeNull();
    expect(bMatch).not.toBeNull();
    const aSuffix = aMatch?.[1] ? Number(aMatch[1]) : 1;
    const bSuffix = Number(bMatch![1]);
    expect(bSuffix).toBe(aSuffix + 1);
  });

  it("returns 415 unsupported_media_type for non-allowlisted MIMEs", async () => {
    const res = await postFromUrl({
      url: `${fixtureBaseUrl}/installer.dmg`,
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: string; message?: string };
    const blob = JSON.stringify(body);
    expect(blob).toMatch(/unsupported_media_type/);
  });

  it("returns 502 for upstream HTTP errors", async () => {
    const res = await postFromUrl({ url: `${fixtureBaseUrl}/bad` });
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).toMatch(/HTTP 500/);
  });

  it("returns 400 for non-http(s) URLs", async () => {
    const res = await postFromUrl({ url: "file:///etc/passwd" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing url", async () => {
    const res = await postFromUrl({});
    expect(res.status).toBe(400);
  });

  it("attributes the edit to X-Caller", async () => {
    const res = await postFromUrl(
      { url: `${fixtureBaseUrl}/article.html` },
      { "x-caller": "mcp-test" },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as FromUrlResponse;
    const sql = createSql();
    const rows = (await sql`
      SELECT by_role FROM entity_edits
      WHERE space_name = ${SPACE} AND entity_path = ${body.path}
      ORDER BY at DESC LIMIT 1
    `) as Array<{ by_role: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].by_role).toBe("mcp-test");
  });

  it("respects the operator kill switch (503)", async () => {
    const prior = process.env.ARKEON_WIKI_FETCH_DISABLED;
    process.env.ARKEON_WIKI_FETCH_DISABLED = "1";
    try {
      const res = await postFromUrl({ url: `${fixtureBaseUrl}/article.html` });
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(JSON.stringify(body)).toMatch(/disabled by operator/);
    } finally {
      if (prior === undefined) delete process.env.ARKEON_WIKI_FETCH_DISABLED;
      else process.env.ARKEON_WIKI_FETCH_DISABLED = prior;
    }
  });
});
