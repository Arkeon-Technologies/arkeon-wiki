// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /wiki — Submit a wiki with typed links.
 *
 * Two-stage processing:
 *   Stage 1 (sync): Validate schema/links, wiki-exists check, mint
 *     placeholders for draft: links, persist wiki as draft.
 *   Stage 2 (sync): Resolve resolve: links via Meilisearch + LLM,
 *     create relationships with span_text, promote to published.
 */

import { createRoute, z } from "@hono/zod-openapi";

import { requireActor, parseJsonBody } from "../lib/http";
import { requireSpaceRole } from "../lib/spaces";
import { ApiError } from "../lib/errors";
import { generateUlid } from "../lib/ids";
import { createRouter } from "../lib/openapi";
import { createSql, withTransaction } from "../lib/sql";
import { setActorContext } from "../lib/actor-context";
import { addEntityToSpaceQuery } from "../lib/entities";
import { indexEntity } from "../lib/meilisearch";
import { backgroundTask } from "../lib/background";
import { parseWikiLinks, type ParsedLink } from "../lib/wiki-links";
import { resolveLinks } from "../lib/wiki-resolve";
import {
  ClassificationLevel,
  EntityIdParam,
  EntitySchema,
  errorResponses,
  jsonContent,
} from "../lib/schemas";

const MAX_DEPTH = 2;

const createWikiRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createWiki",
  tags: ["Wiki"],
  summary: "Submit a wiki with typed links for resolution into the knowledge graph",
  "x-arke-auth": "required",
  "x-arke-rules": [
    "Requires contributor role or above on the target space",
    "All [[entity:id]] links must reference existing visible entities",
    "Returns 409 if a wiki with overlapping primary_entities already exists in the space",
  ],
  request: {
    body: {
      content: jsonContent(
        z.object({
          content: z.string().min(1).describe("Markdown body with typed [[links]]"),
          primary_entities: z
            .array(EntityIdParam)
            .min(1)
            .describe("Entity IDs this wiki is about"),
          space_id: EntityIdParam.describe("Space to create the wiki in"),
          read_level: ClassificationLevel.optional().default(1),
          write_level: ClassificationLevel.optional().default(1),
          depth: z
            .number()
            .int()
            .min(0)
            .optional()
            .default(0)
            .describe("Internal recursion depth — clients should not set this"),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Wiki created and links resolved",
      content: jsonContent(
        z.object({
          wiki: EntitySchema,
          placeholders: z.array(
            z.object({
              id: EntityIdParam,
              label: z.string(),
              status: z.enum(["draft", "gap"]),
            }),
          ),
          relationships_created: z.number().int(),
        }),
      ),
    },
    ...errorResponses([400, 401, 403, 404, 409]),
  },
});

export const wikiRouter = createRouter();

wikiRouter.openapi(createWikiRoute, async (c) => {
  const actor = requireActor(c);
  const body = await parseJsonBody<Record<string, unknown>>(c);
  const sql = createSql();
  const now = new Date().toISOString();

  const content = body.content as string;
  const primary_entities = body.primary_entities as string[];
  const space_id = body.space_id as string;
  const read_level = typeof body.read_level === "number" ? body.read_level : 1;
  const write_level = typeof body.write_level === "number" ? body.write_level : 1;
  const depth = typeof body.depth === "number" ? body.depth : 0;

  if (!content || typeof content !== "string") {
    throw new ApiError(400, "invalid_request", "content is required and must be a string");
  }
  if (!Array.isArray(primary_entities) || primary_entities.length === 0) {
    throw new ApiError(400, "invalid_request", "primary_entities must be a non-empty array of entity IDs");
  }
  if (!space_id || typeof space_id !== "string") {
    throw new ApiError(400, "invalid_request", "space_id is required");
  }

  // --- Auth: require contributor on the target space ---
  await requireSpaceRole(sql, actor, space_id, "contributor");

  // --- Parse links ---
  const links = parseWikiLinks(content, depth, MAX_DEPTH);

  // --- Validate entity: links exist ---
  const entityLinks = links.filter((l) => l.type === "entity");
  if (entityLinks.length > 0) {
    const entityIds = entityLinks.map((l) => l.id!);
    const found = await withTransaction(async (tx) => {
      for (const q of setActorContext(tx, actor)) await q;
      return tx`SELECT id FROM entities WHERE id = ANY(${entityIds}) AND kind = 'entity'`;
    });
    const foundIds = new Set(found.map((r) => String(r.id)));
    for (const link of entityLinks) {
      if (!foundIds.has(link.id!)) {
        throw new ApiError(404, "not_found", `Entity ${link.id} not found or not visible`);
      }
    }
  }

  // --- Validate primary_entities exist ---
  {
    const found = await withTransaction(async (tx) => {
      for (const q of setActorContext(tx, actor)) await q;
      return tx`SELECT id FROM entities WHERE id = ANY(${primary_entities}) AND kind = 'entity'`;
    });
    const foundIds = new Set(found.map((r) => String(r.id)));
    for (const pe of primary_entities) {
      if (!foundIds.has(pe)) {
        throw new ApiError(404, "not_found", `Primary entity ${pe} not found or not visible`);
      }
    }
  }

  // --- Wiki-exists check ---
  {
    const existing = await withTransaction(async (tx) => {
      for (const q of setActorContext(tx, actor)) await q;
      return tx`
        SELECT e.id FROM entities e
        JOIN space_entities se ON se.entity_id = e.id
        WHERE se.space_id = ${space_id}
          AND e.type = 'wiki'
          AND e.kind = 'entity'
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(e.properties->'primary_entities') AS pe
            WHERE pe = ANY(${primary_entities})
          )
        LIMIT 1
      `;
    });
    if (existing.length > 0) {
      throw new ApiError(409, "wiki_exists", `A wiki with overlapping primary entities already exists`, {
        existing_wiki_id: String(existing[0]!.id),
      });
    }
  }

  // --- Stage 1: Mint placeholders and persist draft wiki ---

  const draftLinks = links.filter((l) => l.type === "draft");
  const gapLinks = links.filter((l) => l.type === "gap");
  const resolveLinksArr = links.filter((l) => l.type === "resolve");

  const placeholders: Array<{ id: string; label: string; status: "draft" | "gap" }> = [];

  const wikiId = generateUlid();
  const wikiProperties = {
    content,
    primary_entities,
    status: "draft",
  };

  // Build the atomic transaction for Stage 1
  const stage1Wiki = await withTransaction(async (tx) => {
    for (const q of setActorContext(tx, actor)) await q;

    // Create wiki entity
    const [wiki] = await tx`
      INSERT INTO entities (
        id, kind, type, ver, properties, owner_id,
        read_level, write_level, edited_by, note, created_at, updated_at
      ) VALUES (
        ${wikiId}, 'entity', 'wiki', 1, ${JSON.stringify(wikiProperties)}::jsonb, ${actor.id},
        ${read_level}, ${write_level}, ${actor.id}, NULL, ${now}::timestamptz, ${now}::timestamptz
      ) RETURNING *
    `;

    // Version snapshot
    await tx`
      INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
      VALUES (${wikiId}, 1, ${JSON.stringify(wikiProperties)}::jsonb, ${actor.id}, NULL, ${now}::timestamptz)
    `;

    // Activity
    await tx`
      INSERT INTO entity_activity (entity_id, actor_id, action, detail, ts)
      VALUES (${wikiId}, ${actor.id}, 'entity_created',
        ${JSON.stringify({ kind: "entity", type: "wiki" })}::jsonb, ${now}::timestamptz)
    `;

    // Add wiki to space
    await tx`
      INSERT INTO space_entities (space_id, entity_id, added_by, added_at)
      VALUES (${space_id}, ${wikiId}, ${actor.id}, ${now}::timestamptz)
      ON CONFLICT (space_id, entity_id) DO NOTHING
    `;

    // Mint placeholder entities for draft: links
    for (const link of draftLinks) {
      const phId = generateUlid();
      const phProps = { label: link.label, description: link.description ?? null };

      await tx`
        INSERT INTO entities (
          id, kind, type, ver, properties, owner_id,
          read_level, write_level, edited_by, note, created_at, updated_at
        ) VALUES (
          ${phId}, 'entity', 'placeholder', 1, ${JSON.stringify(phProps)}::jsonb, ${actor.id},
          ${read_level}, ${write_level}, ${actor.id}, NULL, ${now}::timestamptz, ${now}::timestamptz
        )
      `;

      await tx`
        INSERT INTO space_entities (space_id, entity_id, added_by, added_at)
        VALUES (${space_id}, ${phId}, ${actor.id}, ${now}::timestamptz)
        ON CONFLICT (space_id, entity_id) DO NOTHING
      `;

      // Enqueue for background processing
      await tx`
        INSERT INTO wiki_draft_queue (entity_id, depth, owner_agent, deadline, status, created_at)
        VALUES (${phId}, ${depth + 1}, ${actor.id}, ${new Date(Date.now() + 3600_000).toISOString()}::timestamptz, 'pending', ${now}::timestamptz)
      `;

      placeholders.push({ id: phId, label: link.label ?? "", status: "draft" });
    }

    // Record gap links (no entities created)
    for (const link of gapLinks) {
      placeholders.push({ id: "", label: link.label ?? "", status: "gap" });
    }

    return wiki;
  });

  // --- Stage 2: Resolve links and create relationships ---

  // Resolve [[resolve:...]] links
  const resolved = await resolveLinks(resolveLinksArr, actor, space_id);

  // Collect all links that need relationships:
  //   - entity: links → direct reference
  //   - resolved resolve: links → matched entity
  //   - unresolved resolve: links → mint placeholder or gap
  interface LinkTarget {
    targetId: string;
    predicate: string;
    spanText: string;
  }

  const targets: LinkTarget[] = [];

  // Primary entities get "about" relationships
  for (const pe of primary_entities) {
    targets.push({ targetId: pe, predicate: "about", spanText: "" });
  }

  // Entity links get "references" relationships
  for (const link of entityLinks) {
    targets.push({ targetId: link.id!, predicate: "references", spanText: link.spanText });
  }

  // Resolved links
  const unresolvedLinks: ParsedLink[] = [];
  for (const r of resolved) {
    if (r.entityId) {
      targets.push({ targetId: r.entityId, predicate: "references", spanText: r.link.spanText });
    } else {
      unresolvedLinks.push(r.link);
    }
  }

  // Unresolved resolve: links → mint placeholders or gap based on depth
  const unresolvedPlaceholders = await withTransaction(async (tx) => {
    for (const q of setActorContext(tx, actor)) await q;
    const minted: Array<{ id: string; label: string; status: "draft" | "gap" }> = [];

    for (const link of unresolvedLinks) {
      if (depth < MAX_DEPTH) {
        // Mint placeholder
        const phId = generateUlid();
        const phProps = { label: link.label, description: link.description ?? null };

        await tx`
          INSERT INTO entities (
            id, kind, type, ver, properties, owner_id,
            read_level, write_level, edited_by, note, created_at, updated_at
          ) VALUES (
            ${phId}, 'entity', 'placeholder', 1, ${JSON.stringify(phProps)}::jsonb, ${actor.id},
            ${read_level}, ${write_level}, ${actor.id}, NULL, ${now}::timestamptz, ${now}::timestamptz
          )
        `;

        await tx`
          INSERT INTO space_entities (space_id, entity_id, added_by, added_at)
          VALUES (${space_id}, ${phId}, ${actor.id}, ${now}::timestamptz)
          ON CONFLICT (space_id, entity_id) DO NOTHING
        `;

        await tx`
          INSERT INTO wiki_draft_queue (entity_id, depth, owner_agent, deadline, status, created_at)
          VALUES (${phId}, ${depth + 1}, ${actor.id}, ${new Date(Date.now() + 3600_000).toISOString()}::timestamptz, 'pending', ${now}::timestamptz)
        `;

        targets.push({ targetId: phId, predicate: "references", spanText: link.spanText });
        minted.push({ id: phId, label: link.label ?? "", status: "draft" });
      } else {
        minted.push({ id: "", label: link.label ?? "", status: "gap" });
      }
    }
    return minted;
  });

  placeholders.push(...unresolvedPlaceholders);

  // Create all relationships in a single transaction
  let relationshipsCreated = 0;
  if (targets.length > 0) {
    await withTransaction(async (tx) => {
      for (const q of setActorContext(tx, actor)) await q;

      for (const t of targets) {
        const relId = generateUlid();
        const relProps = t.spanText ? { span_text: t.spanText } : {};

        // Insert relationship entity
        await tx`
          INSERT INTO entities (
            id, kind, type, ver, properties, owner_id,
            read_level, write_level, edited_by, note, created_at, updated_at
          )
          SELECT
            ${relId}, 'relationship', 'relationship', 1, ${JSON.stringify(relProps)}::jsonb,
            ${actor.id},
            GREATEST(src.read_level, tgt.read_level),
            GREATEST(src.write_level, tgt.write_level),
            ${actor.id}, NULL, ${now}::timestamptz, ${now}::timestamptz
          FROM entities src, entities tgt
          WHERE src.id = ${wikiId} AND tgt.id = ${t.targetId}
        `;

        // Insert edge
        await tx`
          INSERT INTO relationship_edges (id, source_id, target_id, predicate)
          VALUES (${relId}, ${wikiId}, ${t.targetId}, ${t.predicate})
        `;

        // Add relationship to space
        await tx`
          INSERT INTO space_entities (space_id, entity_id, added_by, added_at)
          VALUES (${space_id}, ${relId}, ${actor.id}, ${now}::timestamptz)
          ON CONFLICT (space_id, entity_id) DO NOTHING
        `;

        relationshipsCreated++;
      }
    });
  }

  // --- Promote wiki to published ---
  const publishedWiki = await withTransaction(async (tx) => {
    for (const q of setActorContext(tx, actor)) await q;

    const publishedProps = { ...wikiProperties, status: "published" };

    const [updated] = await tx`
      UPDATE entities
      SET properties = ${JSON.stringify(publishedProps)}::jsonb,
          ver = ver + 1,
          updated_at = ${now}::timestamptz
      WHERE id = ${wikiId}
      RETURNING *
    `;

    // Version snapshot for the publish
    await tx`
      INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
      VALUES (${wikiId}, 2, ${JSON.stringify(publishedProps)}::jsonb, ${actor.id}, 'published', ${now}::timestamptz)
    `;

    return updated;
  });

  // Index in Meilisearch (background)
  backgroundTask(indexEntity(publishedWiki as Record<string, unknown>));

  // Filter out gap placeholders (no ID) from the response
  const responsePlaceholders = placeholders.filter((p) => p.id !== "");

  return c.json(
    {
      wiki: publishedWiki,
      placeholders: responsePlaceholders,
      relationships_created: relationshipsCreated,
    },
    201,
  );
});
