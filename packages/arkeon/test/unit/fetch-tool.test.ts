// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `fetch` agent tool. Exercises dispatch (URL vs
 * local path), per-target classification (image / text / error),
 * batched mixed-content calls, queue population, and local-text
 * read-gate registration.
 *
 * HTTP fetches are mocked via global.fetch stubbing — no network calls
 * leave the test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ALL_TOOLS } from "../../src/server/agents/tools.js";
import {
  makeContext,
  readGateKey,
  type AgentContext,
} from "../../src/server/agents/runtime.js";
import type { Tool } from "ai";

const SPACE = { name: "fetch-test", watch_dir: "" };

let workdir: string;
let ctx: AgentContext;

function getFetchTool(ctx: AgentContext): Tool {
  return ALL_TOOLS.fetch(ctx);
}

async function exec<T = unknown>(
  tool: Tool,
  input: unknown,
  toolCallId = "test-call-1",
): Promise<T> {
  type Exec = (
    input: unknown,
    options: { toolCallId: string; messages: unknown[] },
  ) => Promise<T>;
  const fn = (tool as unknown as { execute: Exec }).execute;
  return fn(input, { toolCallId, messages: [] });
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "arkeon-fetch-"));
  SPACE.watch_dir = workdir;
  mkdirSync(join(workdir, "sources"), { recursive: true });
  mkdirSync(join(workdir, "images"), { recursive: true });
  ctx = makeContext(SPACE, "test-role");
});

afterEach(() => {
  vi.restoreAllMocks();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface ResultItem {
  target: string;
  kind: "image" | "text" | "error";
  media_type?: string;
  size_bytes?: number;
  text?: string;
  error?: string;
  truncated?: boolean;
}

describe("fetch — local paths", () => {
  it("reads a local PNG, populates imageQueue under the toolCallId", async () => {
    writeFileSync(join(workdir, "images/chart.png"), PNG_BYTES);

    const result = (await exec(
      getFetchTool(ctx),
      { targets: ["images/chart.png"] },
      "call-png",
    )) as { results: ResultItem[]; space: string };

    expect(result.space).toBe(SPACE.name);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].kind).toBe("image");
    expect(result.results[0].media_type).toBe("image/png");
    expect(result.results[0].size_bytes).toBe(PNG_BYTES.length);

    const queued = ctx.imageQueue.get("call-png");
    expect(queued).toBeDefined();
    expect(queued).toHaveLength(1);
    expect(queued![0].mediaType).toBe("image/png");
    expect(queued![0].data.equals(PNG_BYTES)).toBe(true);
  });

  it("reads a local markdown file as text, registers in read-gate", async () => {
    writeFileSync(join(workdir, "sources/notes.md"), "# Hello\n");

    const result = (await exec(getFetchTool(ctx), {
      targets: ["sources/notes.md"],
    })) as { results: ResultItem[] };

    expect(result.results[0].kind).toBe("text");
    expect(result.results[0].media_type).toBe("text/markdown");
    expect(result.results[0].text).toBe("# Hello\n");
    expect(ctx.readPaths.has(readGateKey(SPACE.name, "sources/notes.md"))).toBe(
      true,
    );
  });

  it("returns an error stub for unsupported local file types", async () => {
    writeFileSync(join(workdir, "sources/doc.pdf"), Buffer.from("%PDF fake"));
    const result = (await exec(getFetchTool(ctx), {
      targets: ["sources/doc.pdf"],
    })) as { results: ResultItem[] };
    expect(result.results[0].kind).toBe("error");
    expect(result.results[0].error).toMatch(/unsupported/i);
  });

  it("returns an error stub for missing files", async () => {
    const result = (await exec(getFetchTool(ctx), {
      targets: ["sources/missing.md"],
    })) as { results: ResultItem[] };
    expect(result.results[0].kind).toBe("error");
    expect(result.results[0].error).toMatch(/not found/);
  });

  it("resolves /{currentSpace}/path canonical URL form", async () => {
    // Agents often paste space_url strings from list_entities results.
    writeFileSync(join(workdir, "sources/notes.md"), "ok");
    const result = (await exec(getFetchTool(ctx), {
      targets: [`/${SPACE.name}/sources/notes.md`],
    })) as { results: ResultItem[] };
    expect(result.results[0].kind).toBe("text");
    expect(result.results[0].text).toBe("ok");
  });

  it("resolves /{otherSpace}/path for cross-space fetch (multi-space role)", async () => {
    // Set up a second space with its own watch_dir + image.
    const otherDir = mkdtempSync(join(tmpdir(), "arkeon-fetch-other-"));
    mkdirSync(join(otherDir, "images"), { recursive: true });
    writeFileSync(join(otherDir, "images/chart.png"), PNG_BYTES);
    const otherSpace = { name: "other", watch_dir: otherDir };
    // Multi-space ctx: the triggering space + a second allowed space.
    const multiCtx = makeContext(SPACE, "test-role", {
      allowedSpaces: [SPACE, otherSpace],
    });

    try {
      const result = (await exec(getFetchTool(multiCtx), {
        targets: ["/other/images/chart.png"],
      })) as { results: ResultItem[] };
      expect(result.results[0].kind).toBe("image");
      expect(result.results[0].media_type).toBe("image/png");
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("rejects /{unknownSpace}/path with a clear error", async () => {
    const result = (await exec(getFetchTool(ctx), {
      targets: ["/nonexistent-space/foo.png"],
    })) as { results: ResultItem[] };
    expect(result.results[0].kind).toBe("error");
    expect(result.results[0].error).toMatch(/nonexistent-space/);
    expect(result.results[0].error).toMatch(/not in this role's allowed set/);
  });

  it("rejects cross-space references the role isn't scoped to (single-space role)", async () => {
    // ctx (from beforeEach) has only the triggering space in allowedSpaces.
    // A reference to /other/... should fail even if that space exists
    // elsewhere — the role can't read what it isn't scoped to.
    const result = (await exec(getFetchTool(ctx), {
      targets: ["/other/images/chart.png"],
    })) as { results: ResultItem[] };
    expect(result.results[0].kind).toBe("error");
    expect(result.results[0].error).toMatch(/allowed set/);
  });

  it("refuses path traversal (safeResolve rejects)", async () => {
    const result = (await exec(getFetchTool(ctx), {
      targets: ["../../etc/passwd"],
    })) as { results: ResultItem[] };
    expect(result.results[0].kind).toBe("error");
  });

  it("resolves href-relative paths against `from` (browser-style)", async () => {
    // HTML at sources/post.html references ../images/chart.png — relative
    // to its directory, that's images/chart.png from the watch_dir.
    mkdirSync(join(workdir, "sources"), { recursive: true });
    writeFileSync(join(workdir, "sources/post.html"), "<html/>");
    writeFileSync(join(workdir, "images/chart.png"), PNG_BYTES);

    const result = (await exec(getFetchTool(ctx), {
      targets: ["../images/chart.png"],
      from: "sources/post.html",
    })) as { results: ResultItem[] };

    expect(result.results[0].kind).toBe("image");
    expect(result.results[0].media_type).toBe("image/png");
  });

  it("`from` is ignored for absolute / canonical-prefix paths", async () => {
    writeFileSync(join(workdir, "sources/notes.md"), "ok");
    mkdirSync(join(workdir, "sources"), { recursive: true });
    const result = (await exec(getFetchTool(ctx), {
      targets: [`/${SPACE.name}/sources/notes.md`],
      from: "deep/nested/article.html",
    })) as { results: ResultItem[] };
    expect(result.results[0].kind).toBe("text");
    expect(result.results[0].text).toBe("ok");
  });

  it("`from` still triggers safeResolve guard against escape", async () => {
    mkdirSync(join(workdir, "sources"), { recursive: true });
    const result = (await exec(getFetchTool(ctx), {
      targets: ["../../../../etc/passwd"],
      from: "sources/post.html",
    })) as { results: ResultItem[] };
    expect(result.results[0].kind).toBe("error");
  });

  it("caps text body at 32 KB and reports truncated=true", async () => {
    const big = "x".repeat(40 * 1024);
    writeFileSync(join(workdir, "sources/big.txt"), big);
    const result = (await exec(getFetchTool(ctx), {
      targets: ["sources/big.txt"],
    })) as { results: ResultItem[] };
    expect(result.results[0].kind).toBe("text");
    expect(result.results[0].truncated).toBe(true);
    expect(result.results[0].text!.length).toBe(32 * 1024);
    expect(result.results[0].size_bytes).toBe(big.length);
  });
});

describe("fetch — remote URLs", () => {
  it("fetches an image URL and queues bytes", async () => {
    const buf = PNG_BYTES;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(buf, {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
      ),
    );

    const result = (await exec(
      getFetchTool(ctx),
      { targets: ["https://example.com/chart.png"] },
      "remote-img",
    )) as { results: ResultItem[] };

    expect(result.results[0].kind).toBe("image");
    expect(result.results[0].media_type).toBe("image/png");

    const queued = ctx.imageQueue.get("remote-img");
    expect(queued).toHaveLength(1);
    expect(queued![0].source).toBe("https://example.com/chart.png");
  });

  it("returns text for text/html content-type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>hi</html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      ),
    );

    const result = (await exec(getFetchTool(ctx), {
      targets: ["https://example.com/"],
    })) as { results: ResultItem[] };

    expect(result.results[0].kind).toBe("text");
    expect(result.results[0].media_type).toBe("text/html");
    expect(result.results[0].text).toBe("<html>hi</html>");
  });

  it("returns error for non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("nope", { status: 404, statusText: "Not Found" }),
      ),
    );
    const result = (await exec(getFetchTool(ctx), {
      targets: ["https://example.com/missing"],
    })) as { results: ResultItem[] };
    expect(result.results[0].kind).toBe("error");
    expect(result.results[0].error).toMatch(/404/);
  });

  it("returns error for unsupported MIME (e.g. SVG)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<svg/>", {
            status: 200,
            headers: { "content-type": "image/svg+xml" },
          }),
      ),
    );
    const result = (await exec(getFetchTool(ctx), {
      targets: ["https://example.com/icon.svg"],
    })) as { results: ResultItem[] };
    expect(result.results[0].kind).toBe("error");
    expect(result.results[0].error).toMatch(/unsupported/i);
  });
});

describe("fetch — batched mixed", () => {
  it("returns text + image + error in one call; queues only the image", async () => {
    writeFileSync(join(workdir, "images/chart.png"), PNG_BYTES);
    writeFileSync(join(workdir, "sources/notes.md"), "ok");

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("nope", { status: 404, statusText: "Not Found" }),
      ),
    );

    const result = (await exec(
      getFetchTool(ctx),
      {
        targets: [
          "images/chart.png",
          "sources/notes.md",
          "https://example.com/missing",
        ],
      },
      "mixed-call",
    )) as { results: ResultItem[] };

    expect(result.results).toHaveLength(3);
    expect(result.results[0].kind).toBe("image");
    expect(result.results[1].kind).toBe("text");
    expect(result.results[2].kind).toBe("error");

    // Only the image populates the queue; text and errors don't.
    const queued = ctx.imageQueue.get("mixed-call");
    expect(queued).toHaveLength(1);
    expect(queued![0].source).toBe("images/chart.png");
  });

  it("bundles multiple images under the SAME toolCallId into one queue entry", async () => {
    writeFileSync(join(workdir, "images/a.png"), PNG_BYTES);
    writeFileSync(join(workdir, "images/b.jpg"), Buffer.from([0xff, 0xd8, 0xff]));

    await exec(
      getFetchTool(ctx),
      { targets: ["images/a.png", "images/b.jpg"] },
      "batch-2",
    );

    const queued = ctx.imageQueue.get("batch-2");
    expect(queued).toHaveLength(2);
    expect(queued!.map((q) => q.mediaType)).toEqual(["image/png", "image/jpeg"]);
  });

  it("does not write to imageQueue when no images were fetched", async () => {
    writeFileSync(join(workdir, "sources/notes.md"), "text only");
    await exec(
      getFetchTool(ctx),
      { targets: ["sources/notes.md"] },
      "text-only",
    );
    expect(ctx.imageQueue.has("text-only")).toBe(false);
  });
});

describe("fetch — failure modes", () => {
  it("rejects bodies declared larger than the cap (Content-Length pre-check)", async () => {
    // 50 MB declared, default cap is 25 MB → reject before reading.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(Buffer.alloc(0), {
            status: 200,
            headers: {
              "content-type": "image/png",
              "content-length": String(50 * 1024 * 1024),
            },
          }),
      ),
    );
    const result = (await exec(getFetchTool(ctx), {
      targets: ["https://example.com/huge.png"],
    })) as { results: ResultItem[] };
    expect(result.results[0].kind).toBe("error");
    expect(result.results[0].error).toMatch(/exceeds cap/);
    expect(result.results[0].error).toMatch(/ARKEON_WIKI_FETCH_MAX_BYTES/);
  });

  it("rejects oversize streamed bodies (no/lying Content-Length)", async () => {
    // 30 MB streamed in 1 MB chunks, no Content-Length advertised. The
    // stream cap must catch it once cumulative bytes pass 25 MB.
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 30; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
      ),
    );
    const result = (await exec(getFetchTool(ctx), {
      targets: ["https://example.com/streamy.png"],
    })) as { results: ResultItem[] };
    expect(result.results[0].kind).toBe("error");
    expect(result.results[0].error).toMatch(/exceeded cap/);
  });

  it("returns an error stub when fetch throws (network error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const result = (await exec(getFetchTool(ctx), {
      targets: ["https://example.com/down"],
    })) as { results: ResultItem[] };
    expect(result.results[0].kind).toBe("error");
    expect(result.results[0].error).toMatch(/fetch failed/);
  });

  it("ARKEON_WIKI_FETCH_DISABLED short-circuits every target", async () => {
    vi.stubEnv("ARKEON_WIKI_FETCH_DISABLED", "1");
    writeFileSync(join(workdir, "sources/notes.md"), "would have read this");

    const result = (await exec(getFetchTool(ctx), {
      targets: [
        "https://example.com/x.png",
        "sources/notes.md",
        "images/local.png",
      ],
    })) as { results: ResultItem[] };

    expect(result.results).toHaveLength(3);
    for (const r of result.results) {
      expect(r.kind).toBe("error");
      expect(r.error).toMatch(/disabled by operator/);
      expect(r.error).toMatch(/ARKEON_WIKI_FETCH_DISABLED/);
    }
    // No real fetch should have been issued.
    expect(ctx.imageQueue.size).toBe(0);
  });

  it("ARKEON_WIKI_FETCH_DISABLED treats 'true' / 'yes' / case as truthy", async () => {
    for (const val of ["true", "TRUE", "yes", "Yes"]) {
      vi.stubEnv("ARKEON_WIKI_FETCH_DISABLED", val);
      const result = (await exec(getFetchTool(ctx), {
        targets: ["sources/whatever.md"],
      })) as { results: ResultItem[] };
      expect(result.results[0].kind).toBe("error");
      expect(result.results[0].error).toMatch(/disabled/);
    }
  });
});
