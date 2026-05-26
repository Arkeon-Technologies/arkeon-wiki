// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * MCP server smoke + round-trip tests. Verifies:
 *   1. buildServer() registers the expected tool + prompt set.
 *   2. The capture_thought + save_conversation tools POST/PUT through
 *      to a stub HTTP server with the verbatim payloads they receive
 *      (no summarization, no transformation).
 *
 * Does not spawn a child process or speak JSON-RPC — the registration
 * surface is exercised via the McpServer instance directly. End-to-end
 * stdio handshake is covered manually via the smoke script in
 * docs/user/MCP.md.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { ArkeonWikiClient } from "../../src/mcp/client.js";
import { buildServer } from "../../src/mcp/server.js";

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function startStub(responses: Record<string, { status: number; body: unknown }>): Promise<{
  port: number;
  server: Server;
  recorded: RecordedRequest[];
}> {
  return new Promise((resolve) => {
    const recorded: RecordedRequest[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString("utf-8");
      recorded.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const key = `${req.method} ${(req.url ?? "").split("?")[0]}`;
      const r = responses[key];
      if (!r) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "stub: no handler for " + key }));
        return;
      }
      res.statusCode = r.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(r.body));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, server, recorded });
    });
  });
}

describe("MCP server", () => {
  let stub: { port: number; server: Server; recorded: RecordedRequest[] } | undefined;

  afterEach(async () => {
    if (stub) {
      await new Promise<void>((r) => stub!.server.close(() => r()));
      stub = undefined;
    }
  });

  it("registers 10 tools and 6 prompts (bare names when no space is bound)", async () => {
    const server = buildServer(new ArkeonWikiClient({ apiUrl: "http://localhost:1", caller: "test" }));
    // Access the internal registries — McpServer exposes them as public
    // properties for introspection.
    const tools = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools ?? {});
    const prompts = Object.keys(
      (server as unknown as { _registeredPrompts: Record<string, unknown> })._registeredPrompts ?? {},
    );
    expect(tools.sort()).toEqual(
      [
        "add_source",
        "capture_thought",
        "create_space",
        "daemon_status",
        "list_articles",
        "list_redlinks",
        "list_spaces",
        "read_article",
        "save_conversation",
        "search_wiki",
      ].sort(),
    );
    expect(prompts.sort()).toEqual(["ask", "capture", "fetch", "mode-router", "new-space", "save"].sort());
  });

  it("namespaces tool names with the bound space (defeats Claude Desktop's name-based dedup)", async () => {
    // When ARKEON_WIKI_SPACE is set (the standard claude_desktop_config
    // shape), every registered tool name picks up a `<space>__` prefix.
    // Without this, two arkeon-wiki MCP entries with different spaces
    // both register `list_articles` — Claude Desktop's local tool
    // registry routes a single canonical `list_articles` somewhere, and
    // the other server's version becomes uncallable. Sanitization rule:
    // any non-[a-zA-Z0-9] char in the space becomes `_` so `augustine-
    // chesterton` → `augustine_chesterton__list_articles`.
    const client = new ArkeonWikiClient({
      apiUrl: "http://localhost:1",
      space: "augustine-chesterton",
      caller: "test",
    });
    const server = buildServer(client);
    const tools = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools ?? {});
    expect(tools.sort()).toEqual(
      [
        "augustine_chesterton__add_source",
        "augustine_chesterton__capture_thought",
        "augustine_chesterton__create_space",
        "augustine_chesterton__daemon_status",
        "augustine_chesterton__list_articles",
        "augustine_chesterton__list_redlinks",
        "augustine_chesterton__list_spaces",
        "augustine_chesterton__read_article",
        "augustine_chesterton__save_conversation",
        "augustine_chesterton__search_wiki",
      ].sort(),
    );
  });

  it("capture_thought POSTs the verbatim text body", async () => {
    stub = await startStub({
      "POST /test-space/inbox": {
        status: 201,
        body: { space: "test-space", path: "sources/inbox/2026-05-18/x.md", entity: { source_hash: "abc", created_at: "now" } },
      },
    });
    const client = new ArkeonWikiClient({
      apiUrl: `http://127.0.0.1:${stub.port}`,
      space: "test-space",
      caller: "test",
    });
    const server = buildServer(client);
    const verbatim =
      "This is the user's thought. It has\n\nmultiple paragraphs and a quote: \"do not summarize me\".";
    const handler = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
    })._registeredTools["test_space__capture_thought"];
    await handler.handler({ title: "A thought", text: verbatim, kind: "md", space: null }, {});

    expect(stub.recorded).toHaveLength(1);
    const req = stub.recorded[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/test-space/inbox");
    expect(req.headers["x-caller"]).toBe("test");
    const parsed = JSON.parse(req.body) as { text: string };
    // Verbatim invariant: the text we POSTed must match exactly what the
    // tool received. Any transformation (trim, escape, summarize) would
    // break this.
    expect(parsed.text).toBe(verbatim);
  });

  it("add_source POSTs the URL to /:space/sources/from-url with the caller header", async () => {
    stub = await startStub({
      "POST /test-space/sources/from-url": {
        status: 201,
        body: {
          space: "test-space",
          path: "sources/inbox/2026-05-26/paper.pdf",
          url: "https://example.com/paper.pdf",
          media_type: "application/pdf",
          size_bytes: 12345,
          entity: { kind: "asset", source_hash: "abc", created_at: "now" },
        },
      },
    });
    const client = new ArkeonWikiClient({
      apiUrl: `http://127.0.0.1:${stub.port}`,
      space: "test-space",
      caller: "test",
    });
    const server = buildServer(client);
    const handler = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
    })._registeredTools["test_space__add_source"];
    const result = (await handler.handler(
      { url: "https://example.com/paper.pdf", space: null },
      {},
    )) as { content: Array<{ text: string }>; isError?: boolean };

    expect(stub.recorded).toHaveLength(1);
    const req = stub.recorded[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/test-space/sources/from-url");
    expect(req.headers["x-caller"]).toBe("test");
    expect(JSON.parse(req.body)).toEqual({ url: "https://example.com/paper.pdf" });

    // Text output ships a ready-made markdown link the model can paste
    // verbatim — same contract as the other tools.
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain(
      `[sources/inbox/2026-05-26/paper.pdf](http://127.0.0.1:${stub.port}/test-space/sources/inbox/2026-05-26/paper.pdf)`,
    );
    // Asset kind gets the "binary asset" annotation so the model knows
    // it's not in the editor queue yet.
    expect(result.content[0].text).toMatch(/binary asset/);
  });

  it("add_source surfaces a 415 unsupported_media_type as a structured tool error (not a throw)", async () => {
    stub = await startStub({
      "POST /test-space/sources/from-url": {
        status: 415,
        body: { error: { code: "unsupported_media_type", message: "media type 'application/x-msdownload' not accepted" } },
      },
    });
    const client = new ArkeonWikiClient({
      apiUrl: `http://127.0.0.1:${stub.port}`,
      space: "test-space",
      caller: "test",
    });
    const server = buildServer(client);
    const handler = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
    })._registeredTools["test_space__add_source"];
    const result = (await handler.handler(
      { url: "https://example.com/installer.exe", space: null },
      {},
    )) as { content: Array<{ text: string }>; isError?: boolean };

    // The model needs the daemon's structured failure surfaced as a
    // tool-text + isError, not a thrown exception — otherwise the
    // FETCH_FLOW's paywall/unsupported-media fallback can't fire.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/415/);
    expect(result.content[0].text).toMatch(/unsupported_media_type/);
  });

  it("search_wiki emits ready-made [Label](url) markdown links in text output", async () => {
    stub = await startStub({
      "GET /test-space/search": {
        status: 200,
        body: {
          keyword: {
            hits: [
              { source_path: "wiki/foo.html", label: "Foo", match_count: 3 },
              { source_path: "wiki/bar.html", label: "Bar", match_count: 1 },
            ],
          },
        },
      },
    });
    const client = new ArkeonWikiClient({
      apiUrl: `http://127.0.0.1:${stub.port}`,
      space: "test-space",
      caller: "test",
    });
    const server = buildServer(client);
    const handler = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
    })._registeredTools["test_space__search_wiki"];
    const result = (await handler.handler({ q: "anything", limit: 10, type: null, space: null }, {})) as {
      content: Array<{ text: string }>;
    };
    const text = result.content[0].text;
    expect(text).toContain(`[Foo](http://127.0.0.1:${stub.port}/test-space/wiki/foo.html)`);
    expect(text).toContain(`[Bar](http://127.0.0.1:${stub.port}/test-space/wiki/bar.html)`);
  });

  it("markdownLink helper escapes brackets in label and percent-encodes path segments", () => {
    const client = new ArkeonWikiClient({ apiUrl: "http://localhost:8000", caller: "test" });
    const link = client.markdownLink("space", "wiki/foo bar.html", "Label] with ] brackets");
    expect(link).toBe("[Label\\] with \\] brackets](http://localhost:8000/space/wiki/foo%20bar.html)");
    // Without label, derives display text from path.
    expect(client.markdownLink("space", "wiki/photosynthesis.html")).toBe(
      "[photosynthesis](http://localhost:8000/space/wiki/photosynthesis.html)",
    );
  });

  it("save_conversation auto-suffixes on 409 (typed HttpError detection)", async () => {
    let putCount = 0;
    stub = await startStub({});
    // Replace stub handler with a counter — first PUT 409s, second 201s.
    // We need a custom-shape stub for this test rather than the keyed
    // table.
    await new Promise<void>((r) => stub!.server.close(() => r()));
    const recorded: RecordedRequest[] = [];
    stub.recorded = recorded;
    stub.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      recorded.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf-8") });
      putCount += 1;
      if (putCount === 1) {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: { code: "conflict" } }));
      } else {
        res.statusCode = 201;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            space: "test-space",
            path: recorded[recorded.length - 1].url.slice(1),
            overwrote: false,
            entity: { source_hash: "abc" },
          }),
        );
      }
    });
    await new Promise<void>((r) => stub!.server.listen(stub!.port, "127.0.0.1", () => r()));

    const client = new ArkeonWikiClient({
      apiUrl: `http://127.0.0.1:${stub.port}`,
      space: "test-space",
      caller: "test",
    });
    const server = buildServer(client);
    const handler = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
    })._registeredTools["test_space__save_conversation"];
    await handler.handler({ slug: "collides", transcript: "body", space: null }, {});
    // The retry loop must have made exactly two attempts: first 409,
    // second success with -2 suffix.
    expect(putCount).toBe(2);
    expect(recorded[1].url).toMatch(/-collides-2\.md$/);
  });

  it("save_conversation PUTs the verbatim transcript", async () => {
    stub = await startStub({
      "PUT /test-space/sources/conversations/2026-05-18-1200-foo.md": {
        status: 201,
        body: { space: "test-space", path: "sources/conversations/2026-05-18-1200-foo.md", overwrote: false, entity: { source_hash: "abc" } },
      },
    });
    // We can't pin the date stamp without injecting a clock — instead
    // accept that the stub responds 404 to the actual timestamped path
    // and let the test verify the request body shape on the first
    // recorded request.
    const client = new ArkeonWikiClient({
      apiUrl: `http://127.0.0.1:${stub.port}`,
      space: "test-space",
      caller: "test",
    });
    const server = buildServer(client);
    const transcript = "# Title\n\n## Question\nQ?\n\n## Answer\nA — with **markdown** intact.";
    const handler = (server as unknown as {
      _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>;
    })._registeredTools["test_space__save_conversation"];
    try {
      await handler.handler({ slug: "foo", transcript, space: null }, {});
    } catch {
      // The stub will 404 since we can't predict the timestamp slug —
      // we only care that the body went out verbatim on the first try.
    }
    expect(stub.recorded.length).toBeGreaterThan(0);
    const req = stub.recorded[0];
    expect(req.method).toBe("PUT");
    expect(req.headers["x-caller"]).toBe("test");
    expect(req.body).toBe(transcript);
  });
});
