// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Space-scoped routes, mounted at `/:space/...`.
 *
 *   GET    /:space/entities                  filterable listing
 *   GET    /:space/entities/*                single entity by path (rest of URL)
 *   GET    /:space/redlinks                  red-link queue
 *   GET    /:space/recent                    entity_edits feed
 *   GET    /:space/search?q=...              keyword search
 *   GET    /:space/sources/scan              file inventory by extension
 *   POST   /:space/agents/:role/run          fire one role on demand
 *   POST   /:space/chat                      Phase 3 stub (501)
 *   GET    /:space/chat/:conversation_id     Phase 3 stub (501)
 *   DELETE /:space/chat/:conversation_id     Phase 3 stub (501)
 *
 * The reading-experience endpoints (`/:space/`, `/:space/wiki/*`,
 * `/:space/source/*` that serve rendered HTML pages) are Phase 2.
 */

import { existsSync, readFileSync } from "node:fs";
import { Hono } from "hono";

import type { AppBindings } from "../types.js";
import { ApiError } from "../lib/errors.js";
import { createSql } from "../lib/sql.js";
import { safeResolve } from "../lib/file-edits.js";
import {
  getEntity,
  listEntities,
  listRedLinks,
  parseEntityTypes,
} from "../lib/entities.js";
import {
  MAX_QUERY_PATTERNS,
  searchKeyword,
  type KeywordSearchResult,
} from "../lib/search.js";
import { scanSources } from "../lib/sources-scan.js";
import { loadAgentConfig } from "../agents/config.js";
import { buildAgentRole, listAvailableRoles } from "../agents/role-builder.js";
import { runAgent } from "../agents/runtime.js";
import {
  SpaceBusyError,
  withSpaceMutex,
} from "../agents/space-mutex.js";
import { ALL_TOOLS } from "../agents/tools.js";

export const spaceScopedRouter = new Hono<AppBindings>();

async function spaceWatchDir(spaceName: string): Promise<string> {
  const sql = createSql();
  const rows = await sql`SELECT watch_dir FROM spaces WHERE name = ${spaceName}`;
  if (rows.length === 0) {
    throw new ApiError(404, "not_found", `Space '${spaceName}' not found`);
  }
  return rows[0].watch_dir as string;
}

async function loadSpace(spaceName: string): Promise<{ name: string; watch_dir: string }> {
  const sql = createSql();
  const rows = await sql`SELECT name, watch_dir FROM spaces WHERE name = ${spaceName}`;
  if (rows.length === 0) {
    throw new ApiError(404, "not_found", `Space '${spaceName}' not found`);
  }
  return rows[0] as { name: string; watch_dir: string };
}

// ── /:space/entities ──────────────────────────────────────────────

spaceScopedRouter.get("/:space/entities", async (c) => {
  const space = c.req.param("space");
  await spaceWatchDir(space); // 404 if missing

  const result = await listEntities({
    space_name: space,
    types: parseEntityTypes(c.req.query("type")),
    label_contains: c.req.query("label_contains"),
    path_contains: c.req.query("path_contains"),
    inbound_min: parseNumQuery(c.req.query("inbound_min"), "inbound_min"),
    inbound_max: parseNumQuery(c.req.query("inbound_max"), "inbound_max"),
    outbound_min: parseNumQuery(c.req.query("outbound_min"), "outbound_min"),
    outbound_max: parseNumQuery(c.req.query("outbound_max"), "outbound_max"),
    updated_since: c.req.query("updated_since"),
    edited_by_role: c.req.query("edited_by_role"),
    has_tag: c.req.query("has_tag"),
    not_has_tag: c.req.query("not_has_tag"),
    tag_equals: parseTagEquals(c.req.query("tag_equals")),
    tag_current: c.req.query("tag_current"),
    tag_outdated: c.req.query("tag_outdated"),
    sort: c.req.query("sort"),
    include_counts: (c.req.query("include") ?? "").split(",").includes("counts"),
    limit: parseNumQuery(c.req.query("limit"), "limit"),
    offset: parseNumQuery(c.req.query("offset"), "offset"),
  });
  return c.json(result);
});

// ── /:space/entities/* — single entity by path ────────────────────
//
// The path is everything after `/entities/` (e.g. `/demo/entities/wiki/foo.html`
// → entity at `wiki/foo.html` in space `demo`). `?include=content` reads
// the file body from disk.
spaceScopedRouter.get("/:space/entities/*", async (c) => {
  const space = c.req.param("space");
  const watchDir = await spaceWatchDir(space);

  // Strip `/:space/entities/` from the URL to get the entity path.
  const url = new URL(c.req.url);
  const prefix = `/${space}/entities/`;
  const idx = url.pathname.indexOf(prefix);
  const sourcePath = idx >= 0 ? url.pathname.slice(idx + prefix.length) : "";
  if (!sourcePath) {
    throw new ApiError(400, "validation_error", "missing entity path");
  }
  const decoded = decodeURIComponent(sourcePath);

  const entity = await getEntity(space, decoded);
  if (!entity) {
    throw new ApiError(404, "not_found", `entity not found: ${decoded}`);
  }

  const result: Record<string, unknown> = { ...entity };
  if ((c.req.query("include") ?? "").split(",").includes("content")) {
    const abs = safeResolve(watchDir, decoded);
    result.content = existsSync(abs) ? readFileSync(abs, "utf-8") : null;
  }
  return c.json(result);
});

// ── /:space/redlinks ──────────────────────────────────────────────

spaceScopedRouter.get("/:space/redlinks", async (c) => {
  const space = c.req.param("space");
  await spaceWatchDir(space);

  const result = await listRedLinks({
    space_name: space,
    limit: parseNumQuery(c.req.query("limit"), "limit"),
    offset: parseNumQuery(c.req.query("offset"), "offset"),
  });
  return c.json(result);
});

// ── /:space/sources/scan ──────────────────────────────────────────
// File inventory by extension. Partitions every file in the watch
// directory into supported (the watcher indexes it) vs unsupported
// (silently ignored) — the operator's signal to convert binary
// sources to text before letting the agents loose. Cheap synchronous
// walk; not paginated.

spaceScopedRouter.get("/:space/sources/scan", async (c) => {
  const space = c.req.param("space");
  const watchDir = await spaceWatchDir(space);
  const result = scanSources(watchDir);
  return c.json({ space, watch_dir: watchDir, ...result });
});

// ── /:space/recent ────────────────────────────────────────────────

spaceScopedRouter.get("/:space/recent", async (c) => {
  const space = c.req.param("space");
  await spaceWatchDir(space);

  const limit = Math.min(
    Math.max(parseNumQuery(c.req.query("limit"), "limit") ?? 50, 1),
    500,
  );
  const offset = Math.max(parseNumQuery(c.req.query("offset"), "offset") ?? 0, 0);
  const since = c.req.query("since");
  const role = c.req.query("role");

  const sql = createSql();
  // Dynamic AND-chain workaround: branch on the (since, role) combinations
  // since the tagged-template helper doesn't compose them.
  let rows;
  if (since && role) {
    rows = await sql`
      SELECT entity_path, by_role, edit_kind, edit_note, content_hash, at
      FROM entity_edits
      WHERE space_name = ${space} AND at >= ${since} AND by_role = ${role}
      ORDER BY at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (since) {
    rows = await sql`
      SELECT entity_path, by_role, edit_kind, edit_note, content_hash, at
      FROM entity_edits
      WHERE space_name = ${space} AND at >= ${since}
      ORDER BY at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (role) {
    rows = await sql`
      SELECT entity_path, by_role, edit_kind, edit_note, content_hash, at
      FROM entity_edits
      WHERE space_name = ${space} AND by_role = ${role}
      ORDER BY at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    rows = await sql`
      SELECT entity_path, by_role, edit_kind, edit_note, content_hash, at
      FROM entity_edits
      WHERE space_name = ${space}
      ORDER BY at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  return c.json({ space, edits: rows });
});

// ── POST /:space/agents/:role/run ─────────────────────────────────
//
// Fire one role on demand. Synchronous: blocks until the run finishes
// or errors, then returns a summary. The per-space mutex applies — if
// another role (cron-fired or manual) is in flight, we return 409.
//
// Body is currently ignored. A future iteration may accept
// { trigger_path: string } to force a specific target; today's roles
// pick their own work from list_entities / list_redlinks.

spaceScopedRouter.post("/:space/agents/:role/run", async (c) => {
  const space = c.req.param("space");
  const role = c.req.param("role");
  const spaceRow = await loadSpace(space);

  const config = loadAgentConfig({ spaceDir: spaceRow.watch_dir });
  // Validate the role exists in the merged config (bundled templates +
  // YAML). Catches typos before we try to build the role.
  if (!listAvailableRoles(config).includes(role)) {
    throw new ApiError(
      404,
      "not_found",
      `Role '${role}' not found. Available: ${listAvailableRoles(config).join(", ") || "(none)"}.`,
    );
  }

  let built;
  try {
    built = buildAgentRole(role, config);
  } catch (err) {
    throw new ApiError(
      400,
      "validation_error",
      `Failed to build role '${role}': ${(err as Error).message}`,
    );
  }

  const startedAt = Date.now();
  try {
    const result = await withSpaceMutex(space, role, () =>
      runAgent(built, { space: spaceRow, meta: {} }, ALL_TOOLS, {}),
    );
    return c.json({
      space,
      role,
      duration_ms: Date.now() - startedAt,
      steps: result.steps,
      edits: result.edits.map((e) => ({ path: e.path, kind: e.kind })),
      skipped: result.skipped,
      reason: result.reason,
      usage: result.usage,
      text: result.text,
    });
  } catch (err) {
    if (err instanceof SpaceBusyError) {
      throw new ApiError(
        409,
        "space_busy",
        `Space '${space}' is busy running role '${err.inFlightRole}'.`,
        { in_flight_role: err.inFlightRole },
      );
    }
    throw err;
  }
});

// ── /:space/search ────────────────────────────────────────────────

interface SearchResponse {
  query: string | string[];
  keyword: KeywordSearchResult;
}

spaceScopedRouter.get("/:space/search", async (c) => {
  const space = c.req.param("space");
  await spaceWatchDir(space);

  const queries = c.req.queries("q");
  if (!queries || queries.length === 0) {
    throw new ApiError(400, "validation_error", "q is required");
  }
  if (queries.length > MAX_QUERY_PATTERNS) {
    throw new ApiError(
      400,
      "validation_error",
      `too many q parameters (${queries.length}); max is ${MAX_QUERY_PATTERNS}`,
    );
  }
  const queryForKeyword = queries.length === 1 ? queries[0]! : queries;
  const types = parseEntityTypes(c.req.query("type"));

  const limit = parseNumQuery(c.req.query("limit"), "limit");
  const maxSnippetsPerFile = parseNumQuery(c.req.query("snippets"), "snippets");
  const regex = c.req.query("regex") === "true";

  const keyword = await searchKeyword({
    query: queryForKeyword,
    spaceName: space,
    types,
    limit,
    maxSnippetsPerFile,
    regex,
  });

  const response: SearchResponse = { query: queryForKeyword, keyword };
  return c.json(response);
});

// ── /:space/chat — Phase 3 stubs ──────────────────────────────────

spaceScopedRouter.post("/:space/chat", (c) =>
  c.json(
    { error: { code: "not_implemented", message: "chat ships in Phase 3" } },
    501,
  ),
);

spaceScopedRouter.get("/:space/chat/:conversation_id", (c) =>
  c.json(
    { error: { code: "not_implemented", message: "chat ships in Phase 3" } },
    501,
  ),
);

spaceScopedRouter.delete("/:space/chat/:conversation_id", (c) =>
  c.json(
    { error: { code: "not_implemented", message: "chat ships in Phase 3" } },
    501,
  ),
);

// ── helpers ───────────────────────────────────────────────────────

function parseNumQuery(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new ApiError(
      400,
      "validation_error",
      `Invalid number for "${name}": "${raw}"`,
    );
  }
  return n;
}

/**
 * Parse `?tag_equals=key:value` into the typed shape `listEntities`
 * expects. Splits on the FIRST colon so values may contain colons; keys
 * must not (the conventional dotted-namespace form is colon-free).
 */
function parseTagEquals(
  raw: string | undefined,
): { key: string; value: string } | undefined {
  if (raw === undefined || raw === "") return undefined;
  const idx = raw.indexOf(":");
  if (idx <= 0) {
    throw new ApiError(
      400,
      "validation_error",
      `Invalid tag_equals: expected "key:value", got "${raw}"`,
    );
  }
  return { key: raw.slice(0, idx), value: raw.slice(idx + 1) };
}
