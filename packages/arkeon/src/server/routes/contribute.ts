// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /contribute — append a contribution to a wiki.
 *
 * Routes a (source, subject, excerpt) triple to a target wiki:
 *   - If a wiki with this label/alias already exists in the space, append
 *     to its frontmatter contributions array.
 *   - Otherwise, create a new placeholder wiki file with the contribution
 *     as its only entry.
 *
 * Frontmatter is canonical; the contributions table is repopulated by
 * syncFile() after every write.
 */

import { Hono } from "hono";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AppBindings } from "../types.js";
import { createSql } from "../lib/sql.js";
import { generateUlid } from "../lib/ids.js";
import { ApiError } from "../lib/errors.js";
import { parseFrontmatter, serializeFrontmatter } from "../lib/frontmatter.js";
import { syncFile, type Space } from "../lib/sync.js";
import {
  findMatchingWiki,
  placeholderPath,
  findFreePath,
  withPathLock,
} from "../lib/contributions.js";

interface ContributeBody {
  space_id: string;
  source_id?: string | null;
  subject: {
    label: string;
    subject_type?: string;
    aliases?: string[];
  };
  excerpt: string;
  claim?: string;
}

interface ContributionEntry {
  id: string;
  source_id: string | null;
  excerpt: string;
  claim: string | null;
  added_at: string;
}

export const contributeRouter = new Hono<AppBindings>();

contributeRouter.post("/", async (c) => {
  const body = await c.req.json<ContributeBody>();

  if (!body.space_id) {
    throw new ApiError(400, "validation_error", "space_id is required");
  }
  if (!body.subject?.label || typeof body.subject.label !== "string") {
    throw new ApiError(400, "validation_error", "subject.label is required");
  }
  if (!body.excerpt || typeof body.excerpt !== "string") {
    throw new ApiError(400, "validation_error", "excerpt is required");
  }

  const sql = createSql();

  const spaceRows = await sql`
    SELECT id, name, watch_dir FROM spaces WHERE id = ${body.space_id}
  `;
  if (spaceRows.length === 0) {
    throw new ApiError(404, "not_found", "Space not found");
  }
  const space: Space = {
    id: spaceRows[0].id as string,
    name: spaceRows[0].name as string,
    watch_dir: spaceRows[0].watch_dir as string,
  };

  if (body.source_id) {
    const sourceRows = await sql`
      SELECT id FROM entities
      WHERE id = ${body.source_id} AND space_id = ${body.space_id}
    `;
    if (sourceRows.length === 0) {
      throw new ApiError(404, "not_found", "source_id not found in this space");
    }
  }

  const match = await findMatchingWiki(
    body.space_id,
    body.subject.label,
    body.subject.aliases ?? [],
  );

  const contribution: ContributionEntry = {
    id: generateUlid(),
    source_id: body.source_id ?? null,
    excerpt: body.excerpt,
    claim: body.claim ?? null,
    added_at: new Date().toISOString(),
  };

  if (match) {
    const wikiPath = match.source_path;
    const result = await withPathLock(wikiPath, async () => {
      const absPath = join(space.watch_dir, wikiPath);
      const content = readFileSync(absPath, "utf-8");
      const parsed = parseFrontmatter(content);
      const existing = Array.isArray(parsed.properties.contributions)
        ? (parsed.properties.contributions as unknown[])
        : [];
      const updated = {
        ...parsed.properties,
        contributions: [...existing, contribution],
      };
      writeFileSync(absPath, serializeFrontmatter(updated, parsed.body), "utf-8");
      await syncFile(space, wikiPath);
      return { wiki_id: match.id, wiki_path: wikiPath };
    });

    return c.json({
      ...result,
      was_created: false,
      contribution_id: contribution.id,
    });
  }

  // No match — create a new placeholder.
  const wikiId = generateUlid();
  const desiredPath = placeholderPath(body.subject.subject_type, body.subject.label);
  const wikiPath = findFreePath(space.watch_dir, desiredPath);

  const result = await withPathLock(wikiPath, async () => {
    const absPath = join(space.watch_dir, wikiPath);
    mkdirSync(dirname(absPath), { recursive: true });

    const props: Record<string, unknown> = {
      id: wikiId,
      label: body.subject.label,
    };
    if (body.subject.subject_type) props.subject_type = body.subject.subject_type;
    if (body.subject.aliases?.length) props.aliases = body.subject.aliases;
    props.status = "placeholder";
    props.contributions = [contribution];

    writeFileSync(absPath, serializeFrontmatter(props, ""), "utf-8");
    await syncFile(space, wikiPath);
    return { wiki_id: wikiId, wiki_path: wikiPath };
  });

  return c.json({
    ...result,
    was_created: true,
    contribution_id: contribution.id,
  });
});
