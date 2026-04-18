// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /wiki — Submit a wiki with typed links.
 *
 * Two-stage processing:
 *   Stage 1 (sync): Validate schema/links, wiki-exists check, mint
 *     placeholders for placeholder:/assign: links, persist wiki as draft.
 *   Stage 2 (sync): Resolve resolve: links via Meilisearch + LLM,
 *     create relationships with span_text, promote to published.
 */

import { createRoute, z } from "@hono/zod-openapi";

import { requireActor, parseJsonBody } from "../lib/http";
import { fetchSpaceForActor, resolveDefaultSpace } from "../lib/spaces";
import { ApiError } from "../lib/errors";
import { generateUlid } from "../lib/ids";
import { createRouter } from "../lib/openapi";
import { withTransaction } from "../lib/sql";
import { setActorContext } from "../lib/actor-context";
import { indexEntity } from "../lib/meilisearch";
import { backgroundTask } from "../lib/background";
import {
  processWikiContent,
  createWikiReferences,
  mintPlaceholders,
  applyLinkReplacements,
} from "../lib/wiki-pipeline";
import {
  EntityIdParam,
  EntitySchema,
  errorResponses,
  jsonContent,
} from "../lib/schemas";

const MAX_DEPTH = 2;

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
  "Every parsed link materializes as a `references` relationship from the published wiki to the target (or to a newly-minted placeholder). The wiki page itself is the canonical graph entity for its subject.",
  "",
  "Choosing between resolve / placeholder / assign: use `resolve` when the thing probably already exists and you want the server to find it; use `placeholder` when you want a stub but don't want anything auto-drafted; use `assign` to hand off actual drafting to a background worker.",
  "",
  "After processing, the stored entity has two content fields: `properties.content` (resolved — all links rewritten to `[[entity:ULID]]`) and `properties.submitted_content` (the original input with unresolved link syntax preserved). The same applies when updating content via PUT.",
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
    "All [[entity:ULID]] links must reference existing visible entities — 404 otherwise",
    "[[resolve:...]] links soft-degrade to placeholders on LLM miss / no-match — the wiki still publishes with resolve_warnings",
    "Returns 409 if a wiki with the same normalized label or alias already exists in the space",
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
          type: z
            .string()
            .min(1)
            .max(80)
            .optional()
            .describe("Deprecated alias for subject_type. Stored as properties.subject_type; the internal entity type remains wiki."),
          subject_type: z
            .string()
            .min(1)
            .max(80)
            .optional()
            .describe("Semantic subject type for the page, e.g. person, concept, book, event. Stored as properties.subject_type; the internal entity type remains wiki."),
          aliases: z
            .array(z.string().min(1).max(200))
            .max(50)
            .optional()
            .describe("Alternate titles or spellings for this wiki page. Used for duplicate detection and search metadata."),
          properties: z
            .record(z.string(), z.any())
            .optional()
            .describe("Additional JSON properties to store on the wiki entity. Reserved wiki metadata keys from this request take precedence."),
          space_id: EntityIdParam
            .optional()
            .describe("Space to create the wiki in. Optional — defaults to the only space the actor can contribute to. 400 if ambiguous (multiple candidates) or none."),
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
  const now = new Date().toISOString();

  const content = body.content as string;
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const keywordsRaw = body.keywords;
  const short_description = body.short_description as string;
  const subject_type = typeof body.subject_type === "string"
    ? body.subject_type.trim()
    : typeof body.type === "string"
      ? body.type.trim()
      : undefined;
  const aliasesRaw = body.aliases;
  const extraPropertiesRaw = body.properties;
  const space_id_input = body.space_id;
  const depth = typeof body.depth === "number" ? body.depth : 0;

  if (!content || typeof content !== "string") {
    throw new ApiError(400, "invalid_request", "content is required and must be a string");
  }
  if (!label) {
    throw new ApiError(400, "invalid_request", "label is required and must be a string");
  }
  if (!Array.isArray(keywordsRaw) || keywordsRaw.length === 0 || !keywordsRaw.every((k) => typeof k === "string" && k.trim().length > 0)) {
    throw new ApiError(400, "invalid_request", "keywords must be a non-empty array of non-empty strings");
  }
  const keywords = (keywordsRaw as string[]).map((k) => k.trim());
  if (!short_description || typeof short_description !== "string" || short_description.trim().length < 10) {
    throw new ApiError(400, "invalid_request", "short_description is required and must be at least 10 characters");
  }
  if (body.type !== undefined && (!subject_type || typeof body.type !== "string")) {
    throw new ApiError(400, "invalid_request", "type must be a non-empty string when provided");
  }
  if (body.subject_type !== undefined && (!subject_type || typeof body.subject_type !== "string")) {
    throw new ApiError(400, "invalid_request", "subject_type must be a non-empty string when provided");
  }
  if (aliasesRaw !== undefined && (!Array.isArray(aliasesRaw) || !aliasesRaw.every((a) => typeof a === "string" && a.trim().length > 0))) {
    throw new ApiError(400, "invalid_request", "aliases must be an array of non-empty strings when provided");
  }
  if (
    extraPropertiesRaw !== undefined &&
    (!extraPropertiesRaw || typeof extraPropertiesRaw !== "object" || Array.isArray(extraPropertiesRaw))
  ) {
    throw new ApiError(400, "invalid_request", "properties must be an object when provided");
  }
  const aliases = Array.isArray(aliasesRaw)
    ? [...new Set((aliasesRaw as string[]).map((a) => a.trim()).filter((a) => a.length > 0))]
    : [];
  const extraProperties = sanitizeExtraProperties((extraPropertiesRaw as Record<string, unknown> | undefined) ?? {});

  // space_id is optional — fall back to the actor's single contributable space.
  const space_id =
    typeof space_id_input === "string" && space_id_input.trim().length > 0
      ? space_id_input
      : await resolveDefaultSpace(actor);

  // --- Verify target space exists ---
  const targetSpace = await fetchSpaceForActor(actor, space_id);
  if (!targetSpace) {
    throw new ApiError(404, "not_found", "Space not found");
  }

  const wikiId = generateUlid();

  // --- Process content through the wiki link pipeline ---
  // Use mintInTransaction=false so we can mint placeholders atomically
  // with the wiki insert (if the insert fails, placeholders roll back).
  const pipelineResult = await processWikiContent({
    actor,
    spaceId: space_id,
    content,
    depth,
    maxDepth: MAX_DEPTH,
    mintInTransaction: false,
  });
  const { targets, resolveWarnings, pendingMints, _replacements } = pipelineResult;
  let { placeholders } = pipelineResult;

  const wikiProperties = {
    ...extraProperties,
    label,
    ...(subject_type ? { subject_type } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
    keywords,
    short_description: short_description.trim(),
    content,
    submitted_content: content,
    status: "draft",
  };

  // Collect all replacements — entity/resolve from pipeline + mint from below
  const allReplacements = [...(_replacements ?? [])];

  // Persist wiki as draft + mint placeholders atomically (Stage 1)
  await withTransaction(async (tx) => {
    for (const q of setActorContext(tx, actor)) await q;

    const identityKeys = wikiIdentityKeys(label, aliases);
    for (const identityKey of identityKeys) {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`${space_id}:wiki:${identityKey}`}))`;
    }

    const existing = await tx`
      SELECT e.id, e.properties FROM entities e
      JOIN space_entities se ON se.entity_id = e.id
      WHERE se.space_id = ${space_id}
        AND e.type = 'wiki'
        AND e.kind = 'entity'
    `;
    const conflictingWiki = existing.find((row) => {
      const props = (row.properties as Record<string, unknown>) ?? {};
      const existingAliases = Array.isArray(props.aliases)
        ? props.aliases.filter((a): a is string => typeof a === "string")
        : [];
      return identitySetsOverlap(identityKeys, wikiIdentityKeys(String(props.label ?? ""), existingAliases));
    });
    if (conflictingWiki) {
      throw new ApiError(409, "wiki_exists", `A wiki with this label or alias already exists`, {
        existing_wiki_id: String(conflictingWiki.id),
      });
    }

    // Create wiki entity
    await tx`
      INSERT INTO entities (
        id, kind, type, ver, properties, owner_id,
        edited_by, note, created_at, updated_at
      ) VALUES (
        ${wikiId}, 'entity', 'wiki', 1, ${wikiProperties}::jsonb, ${actor.id},
        ${actor.id}, NULL, ${now}::timestamptz, ${now}::timestamptz
      )
    `;

    // Version snapshot
    await tx`
      INSERT INTO entity_versions (entity_id, ver, properties, edited_by, note, created_at)
      VALUES (${wikiId}, 1, ${wikiProperties}::jsonb, ${actor.id}, NULL, ${now}::timestamptz)
    `;

    // Add wiki to space
    await tx`
      INSERT INTO space_entities (space_id, entity_id, added_by, added_at)
      VALUES (${space_id}, ${wikiId}, ${actor.id}, ${now}::timestamptz)
      ON CONFLICT (space_id, entity_id) DO NOTHING
    `;

    // Mint placeholders inside the same transaction — if the wiki insert
    // fails (e.g. 409 duplicate), placeholders roll back with it.
    if (pendingMints && pendingMints.length > 0) {
      const mintResult = await mintPlaceholders(tx, {
        actor, spaceId: space_id, depth, mints: pendingMints,
      });
      placeholders = mintResult.placeholders;
      allReplacements.push(...mintResult.replacements);
      for (const pl of mintResult.placeholderLinks) {
        targets.push({
          targetId: pl.id,
          predicate: "references",
          spanText: pl.link.spanText,
        });
      }
    }
  });

  // Apply all replacements in a single pass over original content
  const resolvedContent = applyLinkReplacements(content, allReplacements);

  // Create relationships (Stage 2)
  const relationshipsCreated = await createWikiReferences({
    actor,
    wikiId,
    spaceId: space_id,
    targets,
    now,
  });

  // Promote wiki to published
  const publishedProps = { ...wikiProperties, content: resolvedContent, status: "published" };
  const publishedWiki = await withTransaction(async (tx) => {
    for (const q of setActorContext(tx, actor)) await q;

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

function wikiIdentityKeys(label: string, aliases: string[]): string[] {
  return [...new Set([label, ...aliases].map(normalizeWikiIdentity).filter(Boolean))].sort();
}

function identitySetsOverlap(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  return right.some((key) => leftSet.has(key));
}

function sanitizeExtraProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const reserved = new Set([
    "label",
    "subject_type",
    "aliases",
    "keywords",
    "short_description",
    "content",
    "submitted_content",
    "status",
  ]);
  return Object.fromEntries(
    Object.entries(properties).filter(([key]) => !reserved.has(key)),
  );
}

function normalizeWikiIdentity(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}
