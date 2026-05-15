// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Source write-back endpoints.
 *
 *   POST /:space/inbox          server-named source, JSON body
 *   PUT  /:space/sources/*      caller-named source, raw body
 *
 * Both write a file under `watch_dir`, call `applyEdit` so the in-
 * process sync runs synchronously, and return the resulting entity in
 * the response. New sources are not tagged, so the editor cron picks
 * them up on the next tick.
 *
 * Neither endpoint writes wikis — wiki authoring stays inside the
 * agent edit primitives. See tasks/inbox-api.md for the full design.
 */

import { existsSync } from "node:fs";
import { Hono } from "hono";

import type { AppBindings } from "../types.js";
import { ApiError } from "../lib/errors.js";
import { createSql } from "../lib/sql.js";
import { applyEdit, safeResolve } from "../lib/file-edits.js";
import { getEntity, setEntityTag } from "../lib/entities.js";
import {
  buildInboxContent,
  resolveInboxPath,
  type InboxKind,
} from "../lib/inbox.js";
import {
  assertSourcePath,
  assertTextContent,
  sanitizeCaller,
} from "../lib/source-write-guards.js";

export const inboxRouter = new Hono<AppBindings>();

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_TITLE_LEN = 200;
const MAX_TAG_KEY_LEN = 100;
const MAX_TAG_VALUE_LEN = 500;
const MAX_TAGS = 32;

/**
 * Reject before buffering when `Content-Length` is over the cap.
 * Body parsing in Hono (`c.req.json`, `c.req.arrayBuffer`) reads the
 * full payload into memory before returning, so checking byte length
 * after the await is too late on a 1 GB upload. CL is advisory — a
 * client lying about it still gets caught by the post-buffer check —
 * but in honest cases it lets us 413 cheaply.
 */
function assertContentLengthUnderCap(c: { req: { header(name: string): string | undefined } }): void {
  const raw = c.req.header("content-length");
  if (!raw) return;
  const n = Number(raw);
  if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
    throw new ApiError(
      413,
      "payload_too_large",
      `Content-Length ${n} exceeds ${MAX_BODY_BYTES} bytes`,
    );
  }
}

async function loadSpace(
  spaceName: string,
): Promise<{ name: string; watch_dir: string }> {
  const sql = createSql();
  const rows = await sql`
    SELECT name, watch_dir FROM spaces WHERE name = ${spaceName}
  `;
  if (rows.length === 0) {
    throw new ApiError(404, "not_found", `Space '${spaceName}' not found`);
  }
  return rows[0] as { name: string; watch_dir: string };
}

// ── POST /:space/inbox ──────────────────────────────────────────────

interface InboxBody {
  text?: unknown;
  title?: unknown;
  kind?: unknown;
  tags?: unknown;
}

inboxRouter.post("/:space/inbox", async (c) => {
  assertContentLengthUnderCap(c);
  const spaceName = c.req.param("space");
  const space = await loadSpace(spaceName);

  let body: InboxBody;
  try {
    body = await c.req.json<InboxBody>();
  } catch {
    throw new ApiError(400, "validation_error", "request body must be JSON");
  }

  const text = parseText(body.text);
  const title = parseTitle(body.title);
  const kind = parseKind(body.kind);
  const tags = parseTags(body.tags);
  const caller = sanitizeCaller(c.req.header("x-caller"));

  const { relativePath } = resolveInboxPath({
    watchDir: space.watch_dir,
    title,
    kind,
  });

  const content = buildInboxContent({ text, title, kind });

  await applyEdit(
    space,
    { kind: "create", path: relativePath, content },
    { role: caller, edit_kind: "create" },
  );

  for (const [key, value] of Object.entries(tags)) {
    await setEntityTag(spaceName, relativePath, key, value);
  }

  const entity = await getEntity(spaceName, relativePath);
  return c.json({ space: spaceName, path: relativePath, entity }, 201);
});

// ── PUT /:space/sources/* ───────────────────────────────────────────

inboxRouter.put("/:space/sources/*", async (c) => {
  assertContentLengthUnderCap(c);
  const spaceName = c.req.param("space");
  const space = await loadSpace(spaceName);

  const url = new URL(c.req.url);
  const prefix = `/${spaceName}/sources/`;
  const idx = url.pathname.indexOf(prefix);
  const tail = idx >= 0 ? url.pathname.slice(idx + prefix.length) : "";
  if (!tail || tail.endsWith("/")) {
    throw new ApiError(
      400,
      "validation_error",
      "path must point at a file (non-empty, no trailing slash)",
    );
  }
  const relativePath = `sources/${decodeURIComponent(tail)}`;
  assertSourcePath(relativePath);

  const ab = await c.req.arrayBuffer();
  if (ab.byteLength > MAX_BODY_BYTES) {
    throw new ApiError(
      413,
      "payload_too_large",
      `body exceeds ${MAX_BODY_BYTES} bytes`,
    );
  }
  const buf = Buffer.from(ab);
  assertTextContent(buf, relativePath);

  const overwrite = c.req.query("overwrite") === "true";
  const caller = sanitizeCaller(c.req.header("x-caller"));
  const abs = safeResolve(space.watch_dir, relativePath);
  const exists = existsSync(abs);

  if (exists && !overwrite) {
    throw new ApiError(
      409,
      "conflict",
      `path '${relativePath}' exists; pass ?overwrite=true to replace`,
    );
  }

  const content = buf.toString("utf-8");

  if (exists) {
    // Overwrite is destroy + recreate (see tasks/inbox-api.md, open
    // decision #1). Two `entity_edits` rows make the lifecycle honest;
    // the brief gap is harmless given the daemon's single-process model.
    //
    // Best-effort under concurrency: two simultaneous overwrites against
    // the same path can interleave such that the second create observes
    // the first's file and 500s with "already exists". Acceptable for
    // v0 — single-writer per logical resource is the expected use case.
    // A future iteration could thread a "force" option through applyEdit
    // to make this race-free at the primitive level.
    await applyEdit(
      space,
      { kind: "delete", path: relativePath },
      { role: caller, edit_kind: "delete" },
    );
    // `entity_edits.at` has millisecond precision and is part of the PK
    // (see schema/001-foundation.sql). Without a gap, the delete and
    // the subsequent create can land in the same SQLite millisecond and
    // the create's `INSERT OR IGNORE` silently drops its audit row,
    // leaving the lifecycle invisible. A 2ms yield is cheaper than
    // plumbing an explicit `at` through applyEdit and keeps both rows.
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  await applyEdit(
    space,
    { kind: "create", path: relativePath, content },
    { role: caller, edit_kind: "create" },
  );

  const entity = await getEntity(spaceName, relativePath);
  return c.json(
    { space: spaceName, path: relativePath, entity, overwrote: exists },
    exists ? 200 : 201,
  );
});

// ── body parsers ────────────────────────────────────────────────────

function parseText(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ApiError(400, "validation_error", "text is required and must be a string");
  }
  if (raw.length === 0) {
    throw new ApiError(400, "validation_error", "text must be non-empty");
  }
  if (Buffer.byteLength(raw, "utf-8") > MAX_BODY_BYTES) {
    throw new ApiError(413, "payload_too_large", `text exceeds ${MAX_BODY_BYTES} bytes`);
  }
  return raw;
}

function parseTitle(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new ApiError(400, "validation_error", "title must be a string");
  }
  // Empty/whitespace-only title is treated as "no title" — caller gets
  // the ULID-fallback slug, which is the same path as omitting the field
  // entirely. Rejecting here would be unfriendly (clients building JSON
  // dynamically often send "" instead of omitting), so we coerce.
  if (raw.trim().length === 0) return undefined;
  if (raw.length > MAX_TITLE_LEN) {
    throw new ApiError(
      400,
      "validation_error",
      `title exceeds ${MAX_TITLE_LEN} chars`,
    );
  }
  return raw;
}

function parseKind(raw: unknown): InboxKind {
  if (raw === undefined || raw === null) return "md";
  if (raw === "md" || raw === "txt") return raw;
  throw new ApiError(
    400,
    "validation_error",
    `kind must be "md" or "txt" (got ${JSON.stringify(raw)})`,
  );
}

function parseTags(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(
      400,
      "validation_error",
      "tags must be an object of string→string",
    );
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_TAGS) {
    throw new ApiError(
      400,
      "validation_error",
      `tags must have at most ${MAX_TAGS} entries`,
    );
  }
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (k.length === 0 || k.length > MAX_TAG_KEY_LEN) {
      throw new ApiError(
        400,
        "validation_error",
        `tag key '${k}' must be 1-${MAX_TAG_KEY_LEN} chars`,
      );
    }
    if (typeof v !== "string") {
      throw new ApiError(
        400,
        "validation_error",
        `tag value for '${k}' must be a string`,
      );
    }
    if (v.length > MAX_TAG_VALUE_LEN) {
      throw new ApiError(
        400,
        "validation_error",
        `tag value for '${k}' exceeds ${MAX_TAG_VALUE_LEN} chars`,
      );
    }
    out[k] = v;
  }
  return out;
}
