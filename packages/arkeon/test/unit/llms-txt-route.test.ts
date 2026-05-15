// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for the /llms.txt + /help routes. Mounts the real
 * Hono app, fetches both URLs, asserts they serve the LLMS_TXT
 * constant byte-for-byte under `text/plain`. Catches wiring bugs
 * (mounted under a router with a different content-type, alias drift
 * between the two routes) that the content-only smoke test can't see.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../../src/server/app.js";
import { initDb, closeDb } from "../../src/server/lib/sql.js";
import { runMigrations } from "../../src/schema/migrate.js";
import { LLMS_TXT } from "../../src/server/lib/llms-txt.js";

let workdir: string;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "arkeon-llms-route-"));
  const dbPath = join(workdir, "arke.db");
  initDb(dbPath);
  await runMigrations({ dbPath });
  app = createApp();
});

afterAll(() => {
  closeDb();
  rmSync(workdir, { recursive: true, force: true });
});

describe("/llms.txt + /help routes", () => {
  it("GET /llms.txt returns the constant as text/plain", async () => {
    const res = await app.fetch(new Request("http://test/llms.txt"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe(LLMS_TXT);
  });

  it("GET /help serves the same bytes as /llms.txt", async () => {
    const res = await app.fetch(new Request("http://test/help"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe(LLMS_TXT);
  });

  it("POST /spaces rejects a space called 'help' so the route can't be shadowed", async () => {
    const res = await app.fetch(
      new Request("http://test/spaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "help", watch_dir: workdir }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toContain("reserved");
  });
});
