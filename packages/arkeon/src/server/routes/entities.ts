// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AppBindings } from "../types.js";
import { ApiError } from "../lib/errors.js";
import { createSql } from "../lib/sql.js";
import { listEntities, parseEntityTypes } from "../lib/entities.js";

export const entitiesRouter = new Hono<AppBindings>();

/**
 * GET /entities
 *
 * Generic entity listing with type, frontmatter, link-count, recency,
 * and edit-attribution filters. Powers the agent runtime's
 * `list_entities` tool and any UI that wants a unified view across
 * wikis, source files, and stubs.
 *
 * Query params (all optional unless noted):
 *
 *   space_id                    — restrict to a single space
 *   type                        — comma-separated; "wiki", "file", "stub"
 *                                 (omit = all types)
 *   subject_type                — frontmatter `subject_type`
 *   status                      — frontmatter `status`
 *   label_contains              — case-insensitive substring on label
 *   inbound_min, inbound_max    — bound the inbound link count
 *   outbound_min, outbound_max  — bound the outbound link count
 *   has_unresolved_outbound     — "true"/"false"; entities with at least
 *                                 one outbound edge to a stub
 *   updated_since               — ISO timestamp; updated at-or-after
 *   edited_by_role              — last-edit `by_role` (joins
 *                                 entity_latest_edit view)
 *   sort                        — updated_at | label | inbound | outbound
 *   include                     — comma list: "counts" attaches
 *                                 inbound/outbound counts;
 *                                 "relationships" attaches edges
 *   limit, offset               — pagination
 */
entitiesRouter.get("/", async (c) => {
  const include = (c.req.query("include") ?? "")
    .split(",")
    .map((s) => s.trim());

  const result = await listEntities({
    space_id: c.req.query("space_id"),
    types: parseEntityTypes(c.req.query("type")),
    subject_type: c.req.query("subject_type"),
    status: c.req.query("status"),
    label_contains: c.req.query("label_contains"),
    inbound_min: parseNumQuery(c.req.query("inbound_min"), "inbound_min"),
    inbound_max: parseNumQuery(c.req.query("inbound_max"), "inbound_max"),
    outbound_min: parseNumQuery(c.req.query("outbound_min"), "outbound_min"),
    outbound_max: parseNumQuery(c.req.query("outbound_max"), "outbound_max"),
    has_unresolved_outbound: parseBoolQuery(
      c.req.query("has_unresolved_outbound"),
      "has_unresolved_outbound",
    ),
    updated_since: c.req.query("updated_since"),
    edited_by_role: c.req.query("edited_by_role"),
    sort: c.req.query("sort"),
    include_counts: include.includes("counts"),
    include_relationships: include.includes("relationships"),
    limit: parseNumQuery(c.req.query("limit"), "limit"),
    offset: parseNumQuery(c.req.query("offset"), "offset"),
  });
  return c.json(result);
});

/**
 * GET /entities/:id
 *
 * Properties + relationships for a single entity (any type — wiki, file,
 * stub). Pass `?include=content` to read the file body from disk
 * (skipped when source_path is missing or unreadable, e.g. for stubs).
 */
entitiesRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const include = (c.req.query("include") ?? "")
    .split(",")
    .map((s) => s.trim());
  const includeContent = include.includes("content");

  const sql = createSql();
  const rows = await sql`
    SELECT id, space_id, type, label, source_path, properties,
           created_at, updated_at
    FROM entities
    WHERE id = ${id}
  `;
  if (rows.length === 0) {
    throw new ApiError(404, "not_found", "Entity not found");
  }
  const entity = rows[0] as Record<string, unknown>;

  const outgoing = await sql`
    SELECT r.id, r.target_id, r.predicate, r.link_text, r.link_path,
           t.label AS target_label, t.type AS target_type,
           t.source_path AS target_source_path
    FROM relationships r
    JOIN entities t ON t.id = r.target_id
    WHERE r.source_id = ${id}
    ORDER BY r.created_at
  `;

  const incoming = await sql`
    SELECT r.id, r.source_id, r.predicate, r.link_text, r.link_path,
           s.label AS source_label, s.type AS source_type,
           s.source_path AS source_source_path
    FROM relationships r
    JOIN entities s ON s.id = r.source_id
    WHERE r.target_id = ${id}
    ORDER BY r.created_at
  `;

  const result: Record<string, unknown> = {
    ...entity,
    relationships: { outgoing, incoming },
  };

  if (includeContent && entity.source_path) {
    const spaceRows = await sql`
      SELECT watch_dir FROM spaces WHERE id = ${entity.space_id}
    `;
    if (spaceRows.length > 0 && spaceRows[0].watch_dir) {
      const absPath = join(
        spaceRows[0].watch_dir as string,
        entity.source_path as string,
      );
      if (existsSync(absPath)) {
        try {
          result.content = readFileSync(absPath, "utf-8");
        } catch {
          result.content = null;
        }
      } else {
        result.content = null;
      }
    }
  }

  return c.json(result);
});

/**
 * GET /entities/:id/history
 *
 * Chronological audit log of edits to this entity (newest first). Sourced
 * from `entity_edits` (added in 004-edits-and-triggers.sql).
 *
 * Query params:
 *   limit  — max rows (default 50, max 500)
 *   offset — pagination offset
 *   since  — ISO timestamp; only edits at-or-after this
 *   role   — restrict to a specific by_role
 */
entitiesRouter.get("/:id/history", async (c) => {
  const id = c.req.param("id");
  const sql = createSql();

  const entity = await sql`
    SELECT id FROM entities WHERE id = ${id}
  `;
  if (entity.length === 0) {
    throw new ApiError(404, "not_found", "Entity not found");
  }

  const limit = Math.min(
    Math.max(Number(c.req.query("limit") ?? 50), 1),
    500,
  );
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
  const since = c.req.query("since");
  const role = c.req.query("role");

  // The tagged-template SQL helper doesn't support dynamic AND-chains,
  // so we branch on the four since/role combinations.
  let rows;
  if (since && role) {
    rows = await sql`
      SELECT id, by_role, edit_kind, edit_note, content_hash, at
      FROM entity_edits
      WHERE entity_id = ${id} AND at >= ${since} AND by_role = ${role}
      ORDER BY at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (since) {
    rows = await sql`
      SELECT id, by_role, edit_kind, edit_note, content_hash, at
      FROM entity_edits
      WHERE entity_id = ${id} AND at >= ${since}
      ORDER BY at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (role) {
    rows = await sql`
      SELECT id, by_role, edit_kind, edit_note, content_hash, at
      FROM entity_edits
      WHERE entity_id = ${id} AND by_role = ${role}
      ORDER BY at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    rows = await sql`
      SELECT id, by_role, edit_kind, edit_note, content_hash, at
      FROM entity_edits
      WHERE entity_id = ${id}
      ORDER BY at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  return c.json({ entity_id: id, edits: rows });
});

/**
 * DELETE /entities/:id
 *
 * Remove an entity from the index. Cascades to its relationships and
 * (for wikis) its chunks/embeddings. Does not delete the file on disk —
 * the watcher will recreate the entity if the file is still there. To
 * actually remove a wiki file from disk, the agent runtime's
 * `delete_wiki` tool is the right path.
 */
entitiesRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const sql = createSql();

  const rows = await sql`
    DELETE FROM entities WHERE id = ${id}
    RETURNING id, label, type
  `;

  if (rows.length === 0) {
    throw new ApiError(404, "not_found", "Entity not found");
  }

  return c.json({
    deleted: true,
    id,
    label: rows[0].label,
    type: rows[0].type,
  });
});

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

function parseBoolQuery(raw: string | undefined, name: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new ApiError(
    400,
    "validation_error",
    `Invalid boolean for "${name}": expected true/false/1/0`,
  );
}
