// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared wiki content pipeline — link parsing, resolution, placeholder
 * minting, relationship management. Used by both POST /wiki (create) and
 * PUT /wiki/{id} (update).
 */

import type { Actor } from "../types";
import type { SqlClient } from "./sql";
import { withTransaction } from "./sql";
import { setActorContext } from "./actor-context";
import { generateUlid } from "./ids";
import { isLlmConfigured } from "./llm";
import { ApiError } from "./errors";
import { parseWikiLinks, WikiLinkParseError, type ParsedLink } from "./wiki-links";
import { resolveLinks } from "./wiki-resolve";

// ── Types ──────────────────────────────────────────────────────────

type PlaceholderStatus = "placeholder" | "assigned";

export interface WikiContentResult {
  /** Content with all links replaced by [[entity:ULID]] */
  resolvedContent: string;
  /** Placeholders minted during this run */
  placeholders: Array<{ id: string; label: string; status: PlaceholderStatus }>;
  /** Relationship targets to create */
  targets: LinkTarget[];
  /** Warnings from resolve: links that fell back */
  resolveWarnings: Array<{ label: string; reason: "llm_not_configured" | "no_match" }>;
}

export interface LinkTarget {
  targetId: string;
  predicate: string;
  spanText: string;
}

export interface ExistingRelationship {
  id: string;
  targetId: string;
  predicate: string;
  spanText: string;
}

export interface RelationshipDiff {
  toUpdate: Array<{ id: string; spanText: string }>;
  toCreate: LinkTarget[];
  toDelete: string[]; // relationship entity IDs
}

const REL_PREDICATE_REFERENCES = "references";

// ── Content processing ─────────────────────────────────────────────

/**
 * Process wiki content: parse links, validate entity refs, resolve via
 * LLM, mint placeholders, queue assign links. Returns the resolved
 * content and all side-effect records.
 */
export async function processWikiContent(params: {
  actor: Actor;
  spaceId: string;
  content: string;
  depth: number;
  maxDepth: number;
}): Promise<WikiContentResult> {
  const { actor, spaceId, content, depth, maxDepth } = params;

  // Parse links
  let links: ParsedLink[];
  try {
    links = parseWikiLinks(content, depth, maxDepth);
  } catch (err) {
    if (err instanceof WikiLinkParseError) {
      throw new ApiError(400, "malformed_wiki_links", "Malformed wiki links", {
        links: err.details,
      });
    }
    throw err;
  }

  const replacements: Array<{ offset: number; length: number; value: string }> = [];

  // Validate entity: links
  const entityLinks = links.filter((l) => l.type === "entity");
  const canonicalEntityIds = new Map<string, string>();
  if (entityLinks.length > 0) {
    for (const link of entityLinks) {
      const canonicalId = await resolveVisibleEntityId(actor, link.id!);
      if (!canonicalId) {
        throw new ApiError(404, "not_found", `Entity ${link.id} not found or not visible`);
      }
      canonicalEntityIds.set(link.id!, canonicalId);
      if (canonicalId !== link.id) {
        replacements.push({ offset: link.offset, length: link.length, value: `[[entity:${canonicalId}]]` });
      }
    }
  }

  // Categorize links
  const placeholderLinksIn = links.filter((l) => l.type === "placeholder");
  const assignLinksIn = links.filter((l) => l.type === "assign");
  const resolveLinksArr = links.filter((l) => l.type === "resolve");

  // Resolve resolve: links
  const resolveWarnings: Array<{ label: string; reason: "llm_not_configured" | "no_match" }> = [];
  let resolved: Awaited<ReturnType<typeof resolveLinks>>;

  if (resolveLinksArr.length > 0 && !isLlmConfigured()) {
    resolved = resolveLinksArr.map((link) => ({ link, entityId: null, confidence: 0 }));
    for (const link of resolveLinksArr) {
      resolveWarnings.push({ label: link.label ?? "", reason: "llm_not_configured" });
    }
  } else {
    try {
      resolved = await resolveLinks(resolveLinksArr, actor, spaceId);
    } catch (err) {
      if ((err as Error).message.includes("LLM configuration missing")) {
        resolved = resolveLinksArr.map((link) => ({ link, entityId: null, confidence: 0 }));
        for (const link of resolveLinksArr) {
          resolveWarnings.push({ label: link.label ?? "", reason: "llm_not_configured" });
        }
      } else {
        throw err;
      }
    }
    for (const r of resolved) {
      if (!r.entityId && !resolveWarnings.some((w) => w.label === (r.link.label ?? ""))) {
        resolveWarnings.push({ label: r.link.label ?? "", reason: "no_match" });
      }
    }
  }

  // Mint placeholders for placeholder: and assign: links
  const placeholders: Array<{ id: string; label: string; status: PlaceholderStatus }> = [];
  const placeholderLinks: Array<{ id: string; link: ParsedLink }> = [];
  const now = new Date().toISOString();

  const stage1Mints: Array<{ link: ParsedLink; status: PlaceholderStatus }> = [
    ...placeholderLinksIn.map((link) => ({ link, status: "placeholder" as const })),
    ...assignLinksIn.map((link) => ({ link, status: "assigned" as const })),
  ];

  if (stage1Mints.length > 0) {
    await withTransaction(async (tx) => {
      for (const q of setActorContext(tx, actor)) await q;

      for (const { link, status } of stage1Mints) {
        const phId = generateUlid();
        const phProps = { label: link.label, description: link.description ?? null, status };

        await tx`
          INSERT INTO entities (
            id, kind, type, ver, properties, owner_id,
            edited_by, note, created_at, updated_at
          ) VALUES (
            ${phId}, 'entity', 'placeholder', 1, ${phProps}::jsonb, ${actor.id},
            ${actor.id}, NULL, ${now}::timestamptz, ${now}::timestamptz
          )
        `;

        await tx`
          INSERT INTO space_entities (space_id, entity_id, added_by, added_at)
          VALUES (${spaceId}, ${phId}, ${actor.id}, ${now}::timestamptz)
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
    });
  }

  // Build relationship targets
  const targets: LinkTarget[] = [];

  // Entity links
  for (const link of entityLinks) {
    targets.push({
      targetId: canonicalEntityIds.get(link.id!) ?? link.id!,
      predicate: REL_PREDICATE_REFERENCES,
      spanText: link.spanText,
    });
  }

  // Placeholder/assign links
  for (const pl of placeholderLinks) {
    targets.push({
      targetId: pl.id,
      predicate: REL_PREDICATE_REFERENCES,
      spanText: pl.link.spanText,
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

  // Unresolved resolve: links → unqueued placeholders
  if (unresolvedLinks.length > 0) {
    const minted = await withTransaction(async (tx) => {
      for (const q of setActorContext(tx, actor)) await q;
      const result: Array<{ id: string; label: string; status: PlaceholderStatus }> = [];

      for (const link of unresolvedLinks) {
        const phId = generateUlid();
        const phProps = { label: link.label, description: link.description ?? null, status: "placeholder" };

        await tx`
          INSERT INTO entities (
            id, kind, type, ver, properties, owner_id,
            edited_by, note, created_at, updated_at
          ) VALUES (
            ${phId}, 'entity', 'placeholder', 1, ${phProps}::jsonb, ${actor.id},
            ${actor.id}, NULL, ${now}::timestamptz, ${now}::timestamptz
          )
        `;

        await tx`
          INSERT INTO space_entities (space_id, entity_id, added_by, added_at)
          VALUES (${spaceId}, ${phId}, ${actor.id}, ${now}::timestamptz)
          ON CONFLICT (space_id, entity_id) DO NOTHING
        `;

        targets.push({ targetId: phId, predicate: REL_PREDICATE_REFERENCES, spanText: link.spanText });
        result.push({ id: phId, label: link.label ?? "", status: "placeholder" });
        replacements.push({ offset: link.offset, length: link.length, value: `[[entity:${phId}]]` });
      }
      return result;
    });
    placeholders.push(...minted);
  }

  const resolvedContent = applyLinkReplacements(content, replacements);

  return { resolvedContent, placeholders, targets, resolveWarnings };
}

// ── Relationship management ────────────────────────────────────────

/**
 * Fetch existing "references" relationships from a wiki entity.
 */
export async function fetchWikiReferences(
  actor: Actor,
  wikiId: string,
): Promise<ExistingRelationship[]> {
  const rows = await withTransaction(async (tx) => {
    for (const q of setActorContext(tx, actor)) await q;
    return tx`
      SELECT re.id, re.target_id, re.predicate, e.properties
      FROM relationship_edges re
      JOIN entities e ON e.id = re.id
      WHERE re.source_id = ${wikiId} AND re.predicate = ${REL_PREDICATE_REFERENCES}
    `;
  });

  return rows.map((row) => ({
    id: String(row.id),
    targetId: String(row.target_id),
    predicate: String(row.predicate),
    spanText: ((row.properties as Record<string, unknown>)?.span_text as string) ?? "",
  }));
}

/**
 * Diff existing relationships against new targets.
 * - Kept (same target_id + predicate): update span_text
 * - New (target not in existing): create
 * - Removed (existing target not in new): delete
 */
export function diffWikiReferences(
  existing: ExistingRelationship[],
  newTargets: LinkTarget[],
): RelationshipDiff {
  const existingByTarget = new Map<string, ExistingRelationship>();
  for (const rel of existing) {
    existingByTarget.set(`${rel.targetId}:${rel.predicate}`, rel);
  }

  const newByTarget = new Set<string>();
  const toUpdate: Array<{ id: string; spanText: string }> = [];
  const toCreate: LinkTarget[] = [];

  for (const target of newTargets) {
    const key = `${target.targetId}:${target.predicate}`;
    newByTarget.add(key);
    const existingRel = existingByTarget.get(key);
    if (existingRel) {
      // Existing relationship — update span_text
      toUpdate.push({ id: existingRel.id, spanText: target.spanText });
    } else {
      // New relationship
      toCreate.push(target);
    }
  }

  // Relationships no longer in the new set
  const toDelete: string[] = [];
  for (const rel of existing) {
    const key = `${rel.targetId}:${rel.predicate}`;
    if (!newByTarget.has(key)) {
      toDelete.push(rel.id);
    }
  }

  return { toUpdate, toCreate, toDelete };
}

/**
 * Apply a relationship diff: update span_text on kept relationships,
 * create new ones, delete removed ones.
 */
export async function applyRelationshipDiff(params: {
  actor: Actor;
  wikiId: string;
  spaceId: string;
  diff: RelationshipDiff;
  now: string;
}): Promise<{ created: number; updated: number; deleted: string[] }> {
  const { actor, wikiId, spaceId, diff, now } = params;

  return withTransaction(async (tx) => {
    for (const q of setActorContext(tx, actor)) await q;

    // Update existing relationships' span_text
    for (const { id, spanText } of diff.toUpdate) {
      const props = spanText ? { span_text: spanText } : {};
      await tx`
        UPDATE entities
        SET properties = ${props}::jsonb,
            updated_at = ${now}::timestamptz
        WHERE id = ${id}
      `;
    }

    // Create new relationships
    for (const t of diff.toCreate) {
      const relId = generateUlid();
      const relProps = t.spanText ? { span_text: t.spanText } : {};

      await tx`
        INSERT INTO entities (
          id, kind, type, ver, properties, owner_id,
          edited_by, note, created_at, updated_at
        ) VALUES (
          ${relId}, 'relationship', 'relationship', 1, ${relProps}::jsonb,
          ${actor.id},
          ${actor.id}, NULL, ${now}::timestamptz, ${now}::timestamptz
        )
      `;

      await tx`
        INSERT INTO relationship_edges (id, source_id, target_id, predicate)
        VALUES (${relId}, ${wikiId}, ${t.targetId}, ${t.predicate})
      `;

      await tx`
        INSERT INTO space_entities (space_id, entity_id, added_by, added_at)
        VALUES (${spaceId}, ${relId}, ${actor.id}, ${now}::timestamptz)
        ON CONFLICT (space_id, entity_id) DO NOTHING
      `;
    }

    // Delete removed relationships (cascade handles edges + space_entities)
    const deletedIds: string[] = [];
    for (const id of diff.toDelete) {
      await tx`DELETE FROM entities WHERE id = ${id}`;
      deletedIds.push(id);
    }

    return { created: diff.toCreate.length, updated: diff.toUpdate.length, deleted: deletedIds };
  });
}

/**
 * Create all relationships for a newly created wiki (no diffing needed).
 */
export async function createWikiReferences(params: {
  actor: Actor;
  wikiId: string;
  spaceId: string;
  targets: LinkTarget[];
  now: string;
}): Promise<number> {
  const { actor, wikiId, spaceId, targets, now } = params;
  if (targets.length === 0) return 0;

  return withTransaction(async (tx) => {
    for (const q of setActorContext(tx, actor)) await q;
    let count = 0;

    for (const t of targets) {
      const relId = generateUlid();
      const relProps = t.spanText ? { span_text: t.spanText } : {};

      await tx`
        INSERT INTO entities (
          id, kind, type, ver, properties, owner_id,
          edited_by, note, created_at, updated_at
        ) VALUES (
          ${relId}, 'relationship', 'relationship', 1, ${relProps}::jsonb,
          ${actor.id},
          ${actor.id}, NULL, ${now}::timestamptz, ${now}::timestamptz
        )
      `;

      await tx`
        INSERT INTO relationship_edges (id, source_id, target_id, predicate)
        VALUES (${relId}, ${wikiId}, ${t.targetId}, ${t.predicate})
      `;

      await tx`
        INSERT INTO space_entities (space_id, entity_id, added_by, added_at)
        VALUES (${spaceId}, ${relId}, ${actor.id}, ${now}::timestamptz)
        ON CONFLICT (space_id, entity_id) DO NOTHING
      `;

      count++;
    }

    return count;
  });
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Apply link replacements to content, processing from end to start
 * so offsets remain valid.
 */
export function applyLinkReplacements(
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

/**
 * Follow entity redirects to find the canonical visible entity ID.
 */
export async function resolveVisibleEntityId(
  actor: Actor,
  id: string,
): Promise<string | null> {
  const { createSql } = await import("./sql");
  const sql = createSql();
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
