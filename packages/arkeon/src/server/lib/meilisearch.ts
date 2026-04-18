// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { MeiliSearch } from "meilisearch";
import { withSystemActorContext } from "./actor-context";

const ENTITIES_INDEX = "entities";
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 60_000;
const MAX_PENDING_RETRIES = 500;

let client: MeiliSearch | null = null;
let pendingRetries = 0;

export function isMeilisearchConfigured(): boolean {
  return !!process.env.MEILI_URL;
}

function getClient(): MeiliSearch {
  if (!client) {
    const url = process.env.MEILI_URL;
    if (!url) throw new Error("MEILI_URL not set");
    client = new MeiliSearch({ host: url, apiKey: process.env.MEILI_MASTER_KEY });
  }
  return client;
}

/**
 * Retry a Meilisearch operation with exponential backoff + jitter.
 * Non-blocking — runs entirely in the background after the API responds.
 * Caps concurrent pending retries to avoid memory buildup during extended outages.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) pendingRetries--;
      return result;
    } catch (err) {
      if (attempt === 0 && pendingRetries >= MAX_PENDING_RETRIES) {
        console.warn(`[meilisearch] ${label}: dropping sync (${pendingRetries} retries pending, will catch on reindex)`);
        throw err;
      }
      if (attempt === MAX_RETRIES) {
        if (attempt > 0) pendingRetries--;
        console.error(`[meilisearch] ${label}: failed after ${MAX_RETRIES} retries`, err);
        throw err;
      }
      if (attempt === 0) pendingRetries++;

      // Exponential backoff: 500ms, 2s, 8s, 32s, capped at 60s — plus ±50% jitter
      const baseDelay = Math.min(BASE_DELAY_MS * Math.pow(4, attempt), MAX_DELAY_MS);
      const jitter = baseDelay * (0.5 + Math.random());
      const delay = Math.round(jitter);

      console.warn(`[meilisearch] ${label}: attempt ${attempt + 1} failed, retrying in ${delay}ms (${pendingRetries} pending)`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

interface MeiliEntityDoc {
  id: string;
  note: string;
  type: string;
  kind: string;
  owner_id: string;
  space_ids: string[];
  updated_at: number;
  created_at: number;
  [key: string]: unknown;
}

function toUnix(val: unknown): number {
  if (val instanceof Date) return Math.floor(val.getTime() / 1000);
  if (typeof val === "string") return Math.floor(new Date(val).getTime() / 1000);
  if (typeof val === "number") return val;
  return 0;
}

/**
 * Convert an entity row (from Postgres) into a Meilisearch document.
 * Flattens all properties into the doc so every property is searchable.
 */
export function toMeiliDoc(entity: Record<string, unknown>, spaceIds: string[] = []): MeiliEntityDoc {
  const props = (entity.properties ?? {}) as Record<string, unknown>;

  // Flatten properties — only include string/number/boolean values
  const flatProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      flatProps[key] = value;
    } else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      flatProps[key] = value;
    }
  }

  return {
    ...flatProps,
    id: String(entity.id),
    note: typeof entity.note === "string" ? entity.note : "",
    type: String(entity.type ?? ""),
    kind: String(entity.kind ?? ""),
    owner_id: String(entity.owner_id ?? ""),
    space_ids: spaceIds,
    updated_at: toUnix(entity.updated_at),
    created_at: toUnix(entity.created_at),
  };
}

/**
 * Ensure the entities index exists and has correct settings.
 * Idempotent — safe to call on every boot.
 */
export async function ensureMeiliIndex(): Promise<void> {
  const c = getClient();
  try {
    await c.getIndex(ENTITIES_INDEX);
  } catch {
    await c.createIndex(ENTITIES_INDEX, { primaryKey: "id" });
  }
  await c.index(ENTITIES_INDEX).updateSettings({
    searchableAttributes: ["*"],
    filterableAttributes: ["type", "kind", "owner_id", "space_ids"],
    sortableAttributes: ["updated_at", "created_at"],
  });
}

// ---------------------------------------------------------------------------
// Sync helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the space IDs an entity belongs to.
 *
 * Runs under a system-level RLS context because background indexing is
 * a privileged system operation. See `withSystemActorContext`.
 */
async function fetchSpaceIds(entityId: string): Promise<string[]> {
  return withSystemActorContext(async (tx) => {
    const rows = await tx`SELECT space_id FROM space_entities WHERE entity_id = ${entityId}`;
    return (rows as Array<{ space_id: string }>).map((r) => r.space_id);
  });
}

/**
 * Index a single entity by fetching it + its space memberships from Postgres.
 * Use this when only the entity ID is available (e.g., after classification change).
 *
 * Reads run under a system-level RLS context (see `fetchSpaceIds`).
 */
export async function indexEntityById(entityId: string): Promise<void> {
  if (!isMeilisearchConfigured()) return;
  const { entity, spaceIds } = await withSystemActorContext(async (tx) => {
    const rows = await tx`SELECT * FROM entities WHERE id = ${entityId} LIMIT 1`;
    const row = (rows as Record<string, unknown>[])[0];
    if (!row) return { entity: null, spaceIds: [] };
    const spaceRows = await tx`SELECT space_id FROM space_entities WHERE entity_id = ${entityId}`;
    return {
      entity: row,
      spaceIds: (spaceRows as Array<{ space_id: string }>).map((r) => r.space_id),
    };
  });
  if (!entity) return;
  const doc = toMeiliDoc(entity, spaceIds);
  await withRetry(`index ${entityId}`, () =>
    getClient().index(ENTITIES_INDEX).addDocuments([doc]),
  );
}

/** Add or update a single entity in the search index. */
export async function indexEntity(entity: Record<string, unknown>): Promise<void> {
  if (!isMeilisearchConfigured()) return;
  const spaceIds = await fetchSpaceIds(String(entity.id));
  const doc = toMeiliDoc(entity, spaceIds);
  await withRetry(`index ${entity.id}`, () =>
    getClient().index(ENTITIES_INDEX).addDocuments([doc]),
  );
}

/** Remove a single entity from the search index. */
export async function removeEntity(id: string): Promise<void> {
  if (!isMeilisearchConfigured()) return;
  await withRetry(`remove ${id}`, () =>
    getClient().index(ENTITIES_INDEX).deleteDocument(id),
  );
}

/** Remove multiple entities from the search index. */
export async function removeEntities(ids: string[]): Promise<void> {
  if (!isMeilisearchConfigured() || ids.length === 0) return;
  await withRetry(`remove ${ids.length} entities`, () =>
    getClient().index(ENTITIES_INDEX).deleteDocuments(ids),
  );
}

/** Bulk add/update entities in the search index. */
export async function bulkIndexEntities(
  entities: Record<string, unknown>[],
  spaceIdMap?: Map<string, string[]>,
): Promise<void> {
  if (!isMeilisearchConfigured()) return;
  const c = getClient();
  const docs = entities.map((e) =>
    toMeiliDoc(e, spaceIdMap?.get(String(e.id)) ?? []),
  );
  await c.index(ENTITIES_INDEX).addDocuments(docs);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface MeiliSearchResult {
  ids: string[];
  estimatedTotalHits: number;
}

export interface SearchOptions {
  type?: string;
  kind?: string;
  spaceId?: string;
  limit?: number;
  offset?: number;
}

/**
 * Build Meilisearch filter expressions from search options.
 * All authenticated actors have full access — no permission filters needed.
 */
export function buildSearchFilters(options: SearchOptions): string[] {
  const filters: string[] = [];

  // Default: exclude relationships unless explicitly included
  if (options.kind) {
    filters.push(`kind = "${options.kind}"`);
  } else {
    filters.push(`kind != "relationship"`);
  }

  if (options.type) {
    filters.push(`type = "${options.type}"`);
  }
  if (options.spaceId) {
    filters.push(`space_ids = "${options.spaceId}"`);
  }

  return filters;
}

/**
 * Search entities via Meilisearch. Returns ordered entity IDs.
 */
export async function searchEntities(
  query: string,
  options: {
    filter?: string[];
    limit?: number;
    offset?: number;
    /** Meilisearch attributesToSearchOn — narrows matching to specific
     *  indexed fields (e.g. ["label"] to ignore description + properties). */
    attributesToSearchOn?: string[];
  } = {},
): Promise<MeiliSearchResult> {
  const c = getClient();
  const result = await c.index(ENTITIES_INDEX).search(query, {
    filter: options.filter,
    limit: options.limit ?? 50,
    offset: options.offset ?? 0,
    ...(options.attributesToSearchOn
      ? { attributesToSearchOn: options.attributesToSearchOn }
      : {}),
  });
  return {
    ids: result.hits.map((hit) => String(hit.id)),
    estimatedTotalHits: typeof result.estimatedTotalHits === "number"
      ? result.estimatedTotalHits
      : result.hits.length,
  };
}

/**
 * Execute multiple search queries in a single Meilisearch call.
 * Returns one MeiliSearchResult per input query.
 */
export async function multiSearchEntities(
  queries: Array<{
    query: string;
    filter?: string[];
    limit?: number;
    offset?: number;
  }>,
): Promise<MeiliSearchResult[]> {
  const c = getClient();
  const result = await c.multiSearch({
    queries: queries.map((q) => ({
      indexUid: ENTITIES_INDEX,
      q: q.query,
      filter: q.filter,
      limit: q.limit ?? 20,
      offset: q.offset ?? 0,
    })),
  });
  return result.results.map((r) => ({
    ids: r.hits.map((hit) => String(hit.id)),
    estimatedTotalHits: typeof r.estimatedTotalHits === "number"
      ? r.estimatedTotalHits
      : r.hits.length,
  }));
}
