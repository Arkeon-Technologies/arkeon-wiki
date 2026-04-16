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
import { requireSpaceRole, resolveDefaultSpace } from "../lib/spaces";
import { isLlmConfigured } from "../lib/llm";
import { ApiError } from "../lib/errors";
import { generateUlid } from "../lib/ids";
import { createRouter } from "../lib/openapi";
import { createSql, withTransaction } from "../lib/sql";
import { setActorContext } from "../lib/actor-context";
import { indexEntity } from "../lib/meilisearch";
import { backgroundTask } from "../lib/background";
import { parseWikiLinks, WikiLinkParseError, type ParsedLink } from "../lib/wiki-links";
import { resolveLinks } from "../lib/wiki-resolve";
import {
  ClassificationLevel,
  EntityIdParam,
  EntitySchema,
  errorResponses,
  jsonContent,
} from "../lib/schemas";

const MAX_DEPTH = 2;
const REL_PREDICATE_REFERENCES = "references";

const WIKI_CONTENT_DESCRIPTION = [
  "Markdown body. Typed [[links]] in the content are parsed and turned into relationships when the wiki is published.",
  "",
  "Four link forms — all wrapped in double square brackets:",
  "  [[entity:ULID]]                         Hard reference to an existing visible entity.",
  "  [[resolve:\"Label\"|\"Description\"]]       Let the server find a match via Meilisearch + LLM judge. Soft-degrades to placeholder on miss or when no LLM is configured; never fails the request.",
  "  [[placeholder:\"Label\"|\"Description\"]]   Unwritten stub. Not queued. Leave it, or fill it in later.",
  "  [[assign:\"Label\"|\"Description\"]]        Hand off to the background drafter. Queued for auto-drafting.",
  "",
  "Labels must be double-quoted. Description is optional for resolve/placeholder/assign but recommended — it gives the resolver and future drafters context. Entity IDs are unquoted ULIDs.",
  "",
  "Every parsed link materializes as a `references` relationship from the published wiki to the target (or to a newly-minted placeholder). `primary_entities` materialize as `about` relationships.",
  "",
  "Choosing between resolve / placeholder / assign: use `resolve` when the thing probably already exists and you want the server to find it; use `placeholder` when you want a stub but don't want anything auto-drafted; use `assign` to hand off actual drafting to a background worker.",
  "",
  "Caveat: the parser scans every `[[...]]` pair in the content, including inside fenced code blocks. To discuss link syntax in prose, use alternative delimiters (e.g. `<<entity:id>>`). See GET /help/guide/wiki for a worked example.",
].join("\n");

const createWikiRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createWiki",
  tags: ["Wiki"],
  summary: "Submit a wiki with typed links for resolution into the knowledge graph",
  "x-arke-auth": "required",
  "x-arke-related": ["POST /resolve", "GET /help/guide/wiki"],
  "x-arke-rules": [
    "Requires contributor role or above on the target space",
    "All [[entity:ULID]] links must reference existing visible entities — 404 otherwise",
    "[[resolve:...]] links soft-degrade to placeholders on LLM miss / no-match — the wiki still publishes with resolve_warnings",
    "Returns 409 if a wiki with overlapping primary_entities already exists in the space",
    "If space_id is omitted, falls back to the only space the actor can contribute to; 400 if ambiguous or none",
  ],
  request: {
    body: {
      content: jsonContent(
        z.object({
          content: z.string().min(1).describe(WIKI_CONTENT_DESCRIPTION),
          label: z
            .string()
            .min(1)
            .max(200)
            .describe("Canonical display name for the wiki (like an article title)"),
          keywords: z
            .array(z.string().min(1).max(100))
            .min(1)
            .max(20)
            .describe("Alternate names and search phrasings someone might use to find this wiki"),
          short_description: z
            .string()
            .min(10)
            .max(400)
            .describe("One to two sentences of framing, used in search previews and multi-choice disambiguation"),
          primary_entities: z
            .array(EntityIdParam)
            .min(1)
            .describe("Entity IDs this wiki is about. A wiki with overlapping primary_entities in the same space returns 409."),
          space_id: EntityIdParam
            .optional()
            .describe("Space to create the wiki in. Optional — defaults to the only space the actor can contribute to. 400 if ambiguous (multiple candidates) or none."),
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
              status: z
                .enum(["placeholder", "assigned"])
                .describe("`placeholder` = unwritten stub, not queued. `assigned` = queued for the background drafter."),
            }),
          ),
          relationships_created: z.number().int(),
          resolve_warnings: z
            .array(
              z.object({
                label: z.string(),
                reason: z.enum(["llm_not_configured", "no_match"]),
              }),
            )
            .optional()
            .describe(
              "Emitted when [[resolve:...]] links soft-degrade to placeholders — either because the server has no LLM configured, or because the LLM judge found no matching entity. Never fails the request.",
            ),
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
  const label = body.label as string;
  const keywordsRaw = body.keywords;
  const short_description = body.short_description as string;
  const primary_entities = body.primary_entities as string[];
  const space_id_input = body.space_id;
  const read_level = typeof body.read_level === "number" ? body.read_level : 1;
  const write_level = typeof body.write_level === "number" ? body.write_level : 1;
  const depth = typeof body.depth === "number" ? body.depth : 0;

  if (!content || typeof content !== "string") {
    throw new ApiError(400, "invalid_request", "content is required and must be a string");
  }
  if (!label || typeof label !== "string") {
    throw new ApiError(400, "invalid_request", "label is required and must be a string");
  }
  if (!Array.isArray(keywordsRaw) || keywordsRaw.length === 0 || !keywordsRaw.every((k) => typeof k === "string" && k.trim().length > 0)) {
    throw new ApiError(400, "invalid_request", "keywords must be a non-empty array of non-empty strings");
  }
  const keywords = (keywordsRaw as string[]).map((k) => k.trim());
  if (!short_description || typeof short_description !== "string" || short_description.trim().length < 10) {
    throw new ApiError(400, "invalid_request", "short_description is required and must be at least 10 characters");
  }
  if (!Array.isArray(primary_entities) || primary_entities.length === 0) {
    throw new ApiError(400, "invalid_request", "primary_entities must be a non-empty array of entity IDs");
  }

  // space_id is optional — fall back to the actor's single contributable space.
  const space_id =
    typeof space_id_input === "string" && space_id_input.trim().length > 0
      ? space_id_input
      : await resolveDefaultSpace(actor);

  // --- Auth: require contributor on the target space ---
  await requireSpaceRole(sql, actor, space_id, "contributor");

  // --- Parse links ---
  let links: ParsedLink[];
  try {
    links = parseWikiLinks(content, depth, MAX_DEPTH);
  } catch (err) {
    if (err instanceof WikiLinkParseError) {
      throw new ApiError(400, "malformed_wiki_links", "Malformed wiki links", {
        links: err.details,
      });
    }
    throw err;
  }
  const replacements: Array<{ offset: number; length: number; value: string }> = [];

  // --- Validate entity: links exist ---
  const entityLinks = links.filter((l) => l.type === "entity");
  const canonicalEntityIds = new Map<string, string>();
  if (entityLinks.length > 0) {
    for (const link of entityLinks) {
      const canonicalId = await resolveVisibleEntityId(sql, actor, link.id!);
      if (!canonicalId) {
        throw new ApiError(404, "not_found", `Entity ${link.id} not found or not visible`);
      }
      canonicalEntityIds.set(link.id!, canonicalId);
      if (canonicalId !== link.id) {
        replacements.push({ offset: link.offset, length: link.length, value: `[[entity:${canonicalId}]]` });
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

  // --- Stage 1: Mint placeholders and persist draft wiki ---

  const placeholderLinksIn = links.filter((l) => l.type === "placeholder");
  const assignLinksIn = links.filter((l) => l.type === "assign");
  const resolveLinksArr = links.filter((l) => l.type === "resolve");

  // Resolve before Stage 1 writes anything. resolve: links soft-degrade to
  // placeholders on any failure mode — LLM missing, no match, or judge error —
  // so the wiki publishes with warnings rather than failing the whole request.
  type PlaceholderStatus = "placeholder" | "assigned";
  const resolveWarnings: Array<{ label: string; reason: "llm_not_configured" | "no_match" }> = [];
  let resolved: Awaited<ReturnType<typeof resolveLinks>>;

  if (resolveLinksArr.length > 0 && !isLlmConfigured()) {
    // Server has no LLM — resolve: can't actually match anything, even if
    // Meilisearch would return candidates. Emit llm_not_configured for every
    // resolve: link and skip the resolver entirely. Authors see the true
    // reason rather than a misleading "no_match".
    resolved = resolveLinksArr.map((link) => ({ link, entityId: null, confidence: 0 }));
    for (const link of resolveLinksArr) {
      resolveWarnings.push({ label: link.label ?? "", reason: "llm_not_configured" });
    }
  } else {
    try {
      resolved = await resolveLinks(resolveLinksArr, actor, space_id);
    } catch (err) {
      if ((err as Error).message.includes("LLM configuration missing")) {
        // Defensive fallback: config races with our upfront check (e.g. the
        // file was deleted between isLlmConfigured() and the LLM call).
        resolved = resolveLinksArr.map((link) => ({ link, entityId: null, confidence: 0 }));
        for (const link of resolveLinksArr) {
          resolveWarnings.push({ label: link.label ?? "", reason: "llm_not_configured" });
        }
      } else {
        throw err;
      }
    }
    // For any resolve: link that ran against an LLM but didn't match.
    for (const r of resolved) {
      if (!r.entityId && !resolveWarnings.some((w) => w.label === (r.link.label ?? ""))) {
        resolveWarnings.push({ label: r.link.label ?? "", reason: "no_match" });
      }
    }
  }

  const placeholders: Array<{ id: string; label: string; status: PlaceholderStatus }> = [];
  const placeholderLinks: Array<{ id: string; link: ParsedLink }> = [];

  const wikiId = generateUlid();
  const wikiProperties = {
    label,
    keywords,
    short_description: short_description.trim(),
    content,
    submitted_content: content,
    primary_entities,
    status: "draft",
  };

  // Build the atomic transaction for Stage 1
  await withTransaction(async (tx) => {
    for (const q of setActorContext(tx, actor)) await q;

    // Serialize overlapping wiki submissions. The route rejects any primary
    // entity overlap, so lock each primary entity in sorted order.
    for (const primaryEntityId of canonicalLockEntityIds(primary_entities)) {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`${space_id}:${primaryEntityId}`}))`;
    }

    const existing = await tx`
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
    if (existing.length > 0) {
      throw new ApiError(409, "wiki_exists", `A wiki with overlapping primary entities already exists`, {
        existing_wiki_id: String(existing[0]!.id),
      });
    }

    // Create wiki entity
    const [wiki] = await tx`
      INSERT INTO entities (
        id, kind, type, ver, properties, owner_id,
        read_level, write_level, edited_by, note, created_at, updated_at
      ) VALUES (
        ${wikiId}, 'entity', 'wiki', 1, ${wikiProperties}::jsonb, ${actor.id},
        ${read_level}, ${write_level}, ${actor.id}, NULL, ${now}::timestamptz, ${now}::timestamptz
      ) RETURNING *
    `;

    // Version snapshot
    await tx`
      INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
      VALUES (${wikiId}, 1, ${wikiProperties}::jsonb, ${actor.id}, NULL, ${now}::timestamptz)
    `;

    // Activity
    await tx`
      INSERT INTO entity_activity (entity_id, actor_id, action, detail, ts)
      VALUES (${wikiId}, ${actor.id}, 'entity_created',
        ${{ kind: "entity", type: "wiki" }}::jsonb, ${now}::timestamptz)
    `;

    // Add wiki to space
    await tx`
      INSERT INTO space_entities (space_id, entity_id, added_by, added_at)
      VALUES (${space_id}, ${wikiId}, ${actor.id}, ${now}::timestamptz)
      ON CONFLICT (space_id, entity_id) DO NOTHING
    `;

    // Mint placeholder entities for placeholder: and assign: links.
    // Only assign: links are enqueued for the background drafter.
    const stage1Mints: Array<{ link: ParsedLink; status: PlaceholderStatus }> = [
      ...placeholderLinksIn.map((link) => ({ link, status: "placeholder" as const })),
      ...assignLinksIn.map((link) => ({ link, status: "assigned" as const })),
    ];

    for (const { link, status } of stage1Mints) {
      const phId = generateUlid();
      const phProps = { label: link.label, description: link.description ?? null, status };

      await tx`
        INSERT INTO entities (
          id, kind, type, ver, properties, owner_id,
          read_level, write_level, edited_by, note, created_at, updated_at
        ) VALUES (
          ${phId}, 'entity', 'placeholder', 1, ${phProps}::jsonb, ${actor.id},
          ${read_level}, ${write_level}, ${actor.id}, NULL, ${now}::timestamptz, ${now}::timestamptz
        )
      `;

      await tx`
        INSERT INTO space_entities (space_id, entity_id, added_by, added_at)
        VALUES (${space_id}, ${phId}, ${actor.id}, ${now}::timestamptz)
        ON CONFLICT (space_id, entity_id) DO NOTHING
      `;

      if (status === "assigned") {
        await tx`
          INSERT INTO wiki_draft_queue (entity_id, depth, owner_agent, deadline, status, created_at)
          VALUES (${phId}, ${depth + 1}, ${actor.id}, ${new Date(Date.now() + 3600_000).toISOString()}::timestamptz, 'pending', ${now}::timestamptz)
        `;
      }

      placeholders.push({ id: phId, label: link.label ?? "", status });
      placeholderLinks.push({ id: phId, link });
      replacements.push({ offset: link.offset, length: link.length, value: `[[entity:${phId}]]` });
    }

    return wiki;
  });

  // --- Stage 2: Resolve links and create relationships ---

  // Collect all links that need relationships:
  //   - entity: links → direct reference
  //   - resolved resolve: links → matched entity
  //   - unresolved resolve: links → mint placeholder (unqueued)
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
    targets.push({
      targetId: canonicalEntityIds.get(link.id!) ?? link.id!,
      predicate: REL_PREDICATE_REFERENCES,
      spanText: link.spanText,
    });
  }

  // placeholder: and assign: links get relationships to their newly minted placeholders.
  for (const placeholderLink of placeholderLinks) {
    targets.push({
      targetId: placeholderLink.id,
      predicate: REL_PREDICATE_REFERENCES,
      spanText: placeholderLink.link.spanText,
    });
  }

  // Resolved links
  const unresolvedLinks: ParsedLink[] = [];
  for (const r of resolved) {
    if (r.entityId) {
      targets.push({ targetId: r.entityId, predicate: REL_PREDICATE_REFERENCES, spanText: r.link.spanText });
      replacements.push({ offset: r.link.offset, length: r.link.length, value: `[[entity:${r.entityId}]]` });
    } else {
      unresolvedLinks.push(r.link);
    }
  }

  // Unresolved resolve: links soft-degrade to unqueued placeholders.
  // The caller wrote `resolve:` (intent: find an existing match), so on
  // miss we DON'T queue for auto-drafting — they'd have used `assign:` if
  // they wanted that. Warnings are recorded above.
  const unresolvedPlaceholders = await withTransaction(async (tx) => {
    for (const q of setActorContext(tx, actor)) await q;
    const minted: Array<{ id: string; label: string; status: PlaceholderStatus }> = [];

    for (const link of unresolvedLinks) {
      const phId = generateUlid();
      const phProps = { label: link.label, description: link.description ?? null, status: "placeholder" };

      await tx`
        INSERT INTO entities (
          id, kind, type, ver, properties, owner_id,
          read_level, write_level, edited_by, note, created_at, updated_at
        ) VALUES (
          ${phId}, 'entity', 'placeholder', 1, ${phProps}::jsonb, ${actor.id},
          ${read_level}, ${write_level}, ${actor.id}, NULL, ${now}::timestamptz, ${now}::timestamptz
        )
      `;

      await tx`
        INSERT INTO space_entities (space_id, entity_id, added_by, added_at)
        VALUES (${space_id}, ${phId}, ${actor.id}, ${now}::timestamptz)
        ON CONFLICT (space_id, entity_id) DO NOTHING
      `;

      targets.push({ targetId: phId, predicate: REL_PREDICATE_REFERENCES, spanText: link.spanText });
      minted.push({ id: phId, label: link.label ?? "", status: "placeholder" });
      replacements.push({ offset: link.offset, length: link.length, value: `[[entity:${phId}]]` });
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
            ${relId}, 'relationship', 'relationship', 1, ${relProps}::jsonb,
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
  const publishedContent = applyLinkReplacements(content, replacements);
  const publishedWiki = await withTransaction(async (tx) => {
    for (const q of setActorContext(tx, actor)) await q;

    const publishedProps = { ...wikiProperties, content: publishedContent, status: "published" };

    const [updated] = await tx`
      UPDATE entities
      SET properties = ${publishedProps}::jsonb,
          ver = ver + 1,
          updated_at = ${now}::timestamptz
      WHERE id = ${wikiId}
      RETURNING *
    `;

    // Version snapshot for the publish
    await tx`
      INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
      VALUES (${wikiId}, 2, ${publishedProps}::jsonb, ${actor.id}, 'published', ${now}::timestamptz)
    `;

    return updated;
  });

  // Index in Meilisearch (background)
  backgroundTask(indexEntity(publishedWiki as Record<string, unknown>));

  return c.json(
    {
      wiki: publishedWiki,
      placeholders,
      relationships_created: relationshipsCreated,
      ...(resolveWarnings.length > 0 ? { resolve_warnings: resolveWarnings } : {}),
    },
    201,
  );
});

function applyLinkReplacements(
  content: string,
  replacements: Array<{ offset: number; length: number; value: string }>,
): string {
  if (replacements.length === 0) return content;
  let rewritten = content;
  for (const replacement of [...replacements].sort((a, b) => b.offset - a.offset)) {
    rewritten = rewritten.slice(0, replacement.offset) +
      replacement.value +
      rewritten.slice(replacement.offset + replacement.length);
  }
  return rewritten;
}

function canonicalLockEntityIds(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}

async function resolveVisibleEntityId(
  sql: ReturnType<typeof createSql>,
  actor: ReturnType<typeof requireActor>,
  id: string,
): Promise<string | null> {
  let current = id;
  const seen = new Set<string>();

  for (let i = 0; i < 10; i++) {
    if (seen.has(current)) return null;
    seen.add(current);

    const found = await withTransaction(async (tx) => {
      for (const q of setActorContext(tx, actor)) await q;
      return tx`SELECT id FROM entities WHERE id = ${current} AND kind = 'entity' LIMIT 1`;
    });
    if (found.length > 0) return current;

    const redirectRows = await sql`SELECT new_id FROM entity_redirects WHERE old_id = ${current} LIMIT 1`;
    const redirect = redirectRows[0] as { new_id?: string } | undefined;
    if (!redirect?.new_id) return null;
    current = String(redirect.new_id);
  }

  return null;
}
