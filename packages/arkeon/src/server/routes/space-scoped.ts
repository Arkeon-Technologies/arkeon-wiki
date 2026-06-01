// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The v1 HTTP API surface — six commands.
 *
 *   POST /query        { folder?, kinds?, has_tag?[], not_tag?[], text?, limit?, offset? }
 *   POST /tag          { path, key, value? }
 *   POST /untag        { path, key }
 *   GET  /tags?path=...
 *   GET  /backlinks?path=...
 *   GET  /redlinks?folder=...
 */

import { Hono } from "hono";

import type { AppBindings } from "../types.js";
import { ApiError } from "../lib/errors.js";
import {
  deleteTag,
  getArtifact,
  getBacklinks,
  listArtifacts,
  listRedlinks,
  parseKinds,
  setTag,
} from "../lib/entities.js";

export const apiRouter = new Hono<AppBindings>();

function parseStringArray(raw: unknown, name: string): string[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) {
    throw new ApiError(400, "validation_error", `${name} must be a string array`);
  }
  return raw.map((v, i) => {
    if (typeof v !== "string") {
      throw new ApiError(400, "validation_error", `${name}[${i}] must be a string`);
    }
    return v;
  });
}

function parseNum(raw: unknown, name: string): number | null {
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    throw new ApiError(400, "validation_error", `${name} must be a finite number`);
  }
  return n;
}

function requireString(raw: unknown, name: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiError(400, "validation_error", `${name} is required`);
  }
  return raw;
}

apiRouter.post("/query", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await listArtifacts({
    folder: typeof body.folder === "string" ? body.folder : null,
    kinds: parseKinds(body.kinds),
    has_tag: parseStringArray(body.has_tag, "has_tag"),
    not_tag: parseStringArray(body.not_tag, "not_tag"),
    text: typeof body.text === "string" ? body.text : null,
    limit: parseNum(body.limit, "limit"),
    offset: parseNum(body.offset, "offset"),
  });
  return c.json(result);
});

apiRouter.post("/tag", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const path = requireString(body.path, "path");
  const key = requireString(body.key, "key");
  const value = typeof body.value === "string" ? body.value : "";
  const artifact = await getArtifact(path);
  if (!artifact) {
    throw new ApiError(404, "not_found", `artifact not found: ${path}`);
  }
  await setTag(path, key, value);
  return c.json({ ok: true });
});

apiRouter.post("/untag", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const path = requireString(body.path, "path");
  const key = requireString(body.key, "key");
  const removed = await deleteTag(path, key);
  return c.json({ ok: removed });
});

apiRouter.get("/tags", async (c) => {
  const path = c.req.query("path");
  if (!path) {
    throw new ApiError(400, "validation_error", "path is required");
  }
  const artifact = await getArtifact(path);
  if (!artifact) {
    throw new ApiError(404, "not_found", `artifact not found: ${path}`);
  }
  return c.json({ path, tags: artifact.tags });
});

apiRouter.get("/backlinks", async (c) => {
  const path = c.req.query("path");
  if (!path) {
    throw new ApiError(400, "validation_error", "path is required");
  }
  const backlinks = await getBacklinks(path);
  return c.json({ path, backlinks });
});

apiRouter.get("/redlinks", async (c) => {
  const folder = c.req.query("folder") ?? null;
  const result = await listRedlinks({
    folder,
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : null,
    offset: c.req.query("offset") ? Number(c.req.query("offset")) : null,
  });
  return c.json(result);
});
