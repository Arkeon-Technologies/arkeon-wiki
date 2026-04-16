// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { type ArkeEntity, type ArkeRelationship, type ActivityItem, type ArkeActor, type ArkeComment, type ArkeSpace, type GraphNode, type GraphEdge } from './arke-types'

type RelPage = { relationships: ArkeRelationship[]; cursor: string | null }

export interface RelationshipsResult {
  relationships: ArkeRelationship[]
  outCursor: string | null
  inCursor: string | null
  hasMore: boolean
}

export interface ArkeInstanceClient {
  getActivity(cursor?: string, limit?: number): Promise<{ activity: ActivityItem[]; cursor: string | null }>
  getEntity(id: string): Promise<ArkeEntity>
  /** Fetch first page of relationships (both directions). Returns cursors for pagination. */
  getRelationships(id: string, limit?: number): Promise<RelationshipsResult>
  /** Fetch more relationships using cursors from a previous result. */
  getMoreRelationships(id: string, outCursor: string | null, inCursor: string | null, limit?: number): Promise<RelationshipsResult>
  getEntityTip(id: string): Promise<{ cid: string }>
  /** Fetch a relationship by its entity ID, including source/target details */
  getRelationship(relId: string): Promise<ArkeRelationship>
  /** Fetch an actor by ID (cached) */
  getActor(id: string): Promise<ArkeActor>
  /** Fetch comments for an entity */
  getComments(entityId: string, cursor?: string): Promise<{ comments: ArkeComment[]; cursor: string | null }>
  /** Bulk list entities with optional space filter */
  listEntities(options?: { spaceId?: string; limit?: number; cursor?: string }): Promise<{ entities: ArkeEntity[]; cursor: string | null }>
  /** Fetch activity since a timestamp */
  getActivitySince(since: string, limit?: number): Promise<{ activity: ActivityItem[]; cursor: string | null }>
  /** Fetch lightweight graph data for visualization */
  getGraphData(options?: { spaceId?: string; limit?: number; cursor?: string }): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; cursor: string | null }>
  /** Fetch all spaces */
  getSpaces(): Promise<ArkeSpace[]>
}

/**
 * Create a client for the Arkeon API.
 * When served from the same origin (instance explorer), no baseUrl is needed.
 * For remote instances, pass the full URL (e.g. https://my-network.arkeon.tech).
 */
export function createArkeClient(apiKey?: string, baseUrl = ''): ArkeInstanceClient {
  async function apiFetch<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {}
    if (apiKey) headers['X-API-Key'] = apiKey
    const res = await fetch(`${baseUrl}${path}`, { headers })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Arke API error ${res.status}: ${body}`)
    }
    return res.json() as Promise<T>
  }

  function buildRelUrl(id: string, direction: 'out' | 'in', limit: number, cursor?: string | null): string {
    const params = new URLSearchParams({ direction, limit: String(limit) })
    if (cursor) params.set('cursor', cursor)
    return `/wiki/${id}/relationships?${params.toString()}`
  }

  function dedup(rels: ArkeRelationship[]): ArkeRelationship[] {
    const seen = new Set<string>()
    const result: ArkeRelationship[] = []
    for (const rel of rels) {
      if (!seen.has(rel.id)) {
        seen.add(rel.id)
        result.push(rel)
      }
    }
    return result
  }

  async function fetchBothDirections(
    id: string,
    limit: number,
    outCursor?: string | null,
    inCursor?: string | null,
  ): Promise<RelationshipsResult> {
    const fetches: Promise<RelPage | null>[] = []

    // Only fetch a direction if its cursor isn't exhausted (null means done if we've fetched before)
    const fetchOut = outCursor !== null  // null = exhausted, undefined = first fetch
    const fetchIn = inCursor !== null

    if (fetchOut) {
      fetches.push(apiFetch<RelPage>(buildRelUrl(id, 'out', limit, outCursor || undefined)))
    } else {
      fetches.push(Promise.resolve(null))
    }

    if (fetchIn) {
      fetches.push(apiFetch<RelPage>(buildRelUrl(id, 'in', limit, inCursor || undefined)))
    } else {
      fetches.push(Promise.resolve(null))
    }

    const [outResult, inResult] = await Promise.all(fetches)

    const allRels = dedup([
      ...(outResult?.relationships || []),
      ...(inResult?.relationships || []),
    ])

    const newOutCursor = outResult?.cursor ?? null
    const newInCursor = inResult?.cursor ?? null

    return {
      relationships: allRels,
      outCursor: newOutCursor,
      inCursor: newInCursor,
      hasMore: newOutCursor !== null || newInCursor !== null,
    }
  }

  // Actor cache to avoid repeated lookups
  const actorCache = new Map<string, Promise<ArkeActor>>()

  return {
    async getActivity() {
      // Activity feed was removed in the wiki-first rewrite
      return { activity: [], cursor: null }
    },

    async getEntity(id: string) {
      const data = await apiFetch<{ entity: ArkeEntity }>(`/wiki/${id}`)
      return data.entity
    },

    async getRelationships(id: string, limit = 50) {
      // undefined cursors = first fetch
      return fetchBothDirections(id, limit, undefined, undefined)
    },

    async getMoreRelationships(id: string, outCursor: string | null, inCursor: string | null, limit = 50) {
      return fetchBothDirections(id, limit, outCursor, inCursor)
    },

    async getEntityTip(id: string) {
      return apiFetch<{ cid: string }>(`/wiki/${id}/tip`)
    },

    async getRelationship(relId: string) {
      return apiFetch<ArkeRelationship>(`/relationships/${relId}`)
    },

    async getActor(id: string) {
      let cached = actorCache.get(id)
      if (!cached) {
        cached = apiFetch<{ actor: ArkeActor }>(`/actors/${id}`).then(d => d.actor)
        actorCache.set(id, cached)
        // Remove from cache on error so it can be retried
        cached.catch(() => actorCache.delete(id))
      }
      return cached
    },

    async getComments() {
      // Comments were removed in the wiki-first rewrite
      return { comments: [], cursor: null }
    },

    async listEntities(options?: { spaceId?: string; limit?: number; cursor?: string }) {
      const params = new URLSearchParams({
        limit: String(options?.limit ?? 200),
        sort: 'created_at',
        order: 'desc',
      })
      if (options?.spaceId) params.set('space_id', options.spaceId)
      if (options?.cursor) params.set('cursor', options.cursor)
      return apiFetch<{ entities: ArkeEntity[]; cursor: string | null }>(
        `/wiki?${params.toString()}`
      )
    },

    async getActivitySince() {
      // Activity feed was removed in the wiki-first rewrite
      return { activity: [], cursor: null }
    },

    async getGraphData(options?: { spaceId?: string; limit?: number; cursor?: string }) {
      const params = new URLSearchParams()
      if (options?.limit) params.set('limit', String(options.limit))
      if (options?.spaceId) params.set('space_id', options.spaceId)
      if (options?.cursor) params.set('cursor', options.cursor)
      const qs = params.toString()
      return apiFetch<{ nodes: GraphNode[]; edges: GraphEdge[]; cursor: string | null }>(
        `/graph/data${qs ? `?${qs}` : ''}`
      )
    },

    async getSpaces() {
      const data = await apiFetch<{ spaces: ArkeSpace[] }>('/spaces')
      return data.spaces
    },
  }
}
