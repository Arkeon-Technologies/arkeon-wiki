// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal API client for background workers.
 *
 * Workers call the local Hono API via HTTP instead of querying Postgres
 * directly. This prevents schema drift — if a column is renamed or a
 * query changes in the route layer, the workers break at the HTTP
 * boundary (clear error) instead of silently returning stale data.
 *
 * Uses the admin bootstrap key for authentication (same as the existing
 * submitDraft() pattern in draft-worker.ts).
 */

import type { Actor } from "../../types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InternalApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InternalApiError";
  }
}

// ---------------------------------------------------------------------------
// Base helpers
// ---------------------------------------------------------------------------

function baseUrl(): string {
  const port = process.env.PORT ?? "8000";
  return `http://localhost:${port}`;
}

function adminKey(): string {
  const key = process.env.ADMIN_BOOTSTRAP_KEY;
  if (!key) throw new Error("ADMIN_BOOTSTRAP_KEY not set — cannot call internal API");
  return key;
}

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-API-Key": adminKey(),
  };
}

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(path, baseUrl());
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), { headers: headers() });
  if (res.status === 404 || res.status === 410) return null as T;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new InternalApiError(res.status, "api_error", `GET ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T;
  return { status: res.status, body: json };
}

// ---------------------------------------------------------------------------
// Entity / property helpers
// ---------------------------------------------------------------------------

interface ApiEntity {
  id: string;
  kind: string;
  type: string;
  ver: number;
  properties: Record<string, unknown>;
  owner_id: string;
  edited_by: string;
  note: string | null;
  created_at: string;
  updated_at: string;
  space_ids?: string[];
}

interface ApiRelationship {
  id: string;
  predicate: string;
  source_id: string;
  target_id: string;
  direction: "in" | "out";
  properties: Record<string, unknown>;
  source?: { id: string; kind: string; type: string; properties: Record<string, unknown> };
  target?: { id: string; kind: string; type: string; properties: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Typed convenience methods
// ---------------------------------------------------------------------------

/**
 * Fetch an actor by ID. Returns null if not found.
 * Maps the API response to the internal Actor type used by workers.
 */
export async function getActor(id: string): Promise<Actor | null> {
  const data = await get<{ actor: Record<string, unknown> } | null>(`/actors/${id}`);
  if (!data) return null;
  const a = data.actor;
  const props = (a.properties as Record<string, unknown>) ?? {};
  return {
    id: String(a.id),
    apiKeyId: "",
    keyPrefix: "",
    label: typeof props.label === "string" ? props.label : null,
  };
}

/**
 * Fetch an entity (wiki/placeholder) by ID. Returns null if not found/merged.
 * Use for entities on the /wiki route (excludes file entities).
 */
export async function getEntity(
  id: string,
  view: "full" | "summary" | "expanded" = "full",
): Promise<ApiEntity | null> {
  const data = await get<{ wiki: ApiEntity } | null>(`/wiki/${id}`, { view });
  return data?.wiki ?? null;
}

/**
 * Fetch a file entity by ID. Returns null if not found.
 * Use for source documents (type='file').
 */
export async function getFile(id: string): Promise<ApiEntity | null> {
  const data = await get<{ file: ApiEntity } | null>(`/files/${id}`);
  return data?.file ?? null;
}

/**
 * Fetch relationships for an entity.
 */
export async function getRelationships(
  entityId: string,
  opts?: {
    direction?: "in" | "out" | "both";
    predicate?: string;
    limit?: number;
  },
): Promise<ApiRelationship[]> {
  const data = await get<{ relationships: ApiRelationship[]; cursor: string | null } | null>(
    `/wiki/${entityId}/relationships`,
    {
      direction: opts?.direction,
      predicate: opts?.predicate,
      limit: opts?.limit,
    },
  );
  return data?.relationships ?? [];
}

/**
 * Search entities via Meilisearch.
 */
export async function search(opts: {
  q: string;
  type?: string;
  kind?: string;
  space_id?: string;
  limit?: number;
  offset?: number;
  view?: "full" | "summary";
}): Promise<{ results: ApiEntity[]; estimatedTotalHits: number }> {
  const data = await get<{ results: ApiEntity[]; estimatedTotalHits: number }>("/search", {
    q: opts.q,
    type: opts.type,
    kind: opts.kind,
    space_id: opts.space_id,
    limit: opts.limit,
    offset: opts.offset,
    view: opts.view,
  });
  return data ?? { results: [], estimatedTotalHits: 0 };
}

/**
 * List entities (wikis) with filters and sorting.
 */
export async function listEntities(opts: {
  space_id?: string;
  filter?: string;
  sort?: string;
  order?: string;
  limit?: number;
  view?: "full" | "summary";
}): Promise<ApiEntity[]> {
  const data = await get<{ entities: ApiEntity[]; cursor: string | null }>("/wiki", {
    space_id: opts.space_id,
    filter: opts.filter,
    sort: opts.sort,
    order: opts.order,
    limit: opts.limit,
    view: opts.view,
  });
  return data?.entities ?? [];
}

/**
 * Submit a wiki draft via POST /wiki.
 * Returns the raw status + body so callers can handle 201/409/other.
 */
export async function postWiki(payload: {
  content: string;
  label: string;
  keywords: string[];
  short_description: string;
  space_id: string;
  depth: number;
  aliases?: string[];
  type?: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  return post<Record<string, unknown>>("/wiki", payload);
}

/**
 * Create placeholder entities in a space.
 */
export async function postPlaceholders(
  placeholders: Array<{
    label: string;
    description?: string;
    subject_type?: string;
    relationships?: Array<{ target_id: string; predicate: string; detail?: string }>;
  }>,
  spaceId: string,
): Promise<{ status: number; body: { created: number; placeholders: Array<{ id: string; label: string }> } }> {
  return post<{ created: number; placeholders: Array<{ id: string; label: string }> }>(
    "/wiki/placeholders",
    { placeholders, space_id: spaceId },
  );
}

/**
 * Create an entity redirect (old → new).
 */
export async function postRedirect(
  oldId: string,
  targetId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return post<Record<string, unknown>>(`/wiki/${oldId}/redirect`, { target_id: targetId });
}

// Re-export the ApiEntity type for consumers
export type { ApiEntity, ApiRelationship };
