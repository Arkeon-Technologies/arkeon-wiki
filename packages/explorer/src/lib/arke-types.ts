// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface ArkeRelationship {
  id: string
  predicate: string
  source_id: string
  target_id: string
  properties: string | Record<string, unknown>
  target?: {
    id: string
    kind: string
    type: string
    properties: Record<string, unknown>
  }
  source?: {
    id: string
    kind: string
    type: string
    properties: Record<string, unknown>
  }
}

export interface ArkeEntity {
  id: string
  cid?: string
  kind: string
  type: string
  properties: Record<string, unknown>
  ver: number
  created_at: string
  updated_at: string
  owner_id?: string
  space_ids?: string[]
}

export interface LoadedEntity {
  entity: ArkeEntity
  label?: string
  description?: string
  relationships: ArkeRelationship[]
  /** Cursor for fetching more outgoing relationships (null = exhausted) */
  outCursor: string | null
  /** Cursor for fetching more incoming relationships (null = exhausted) */
  inCursor: string | null
  /** Whether there are more relationships to fetch */
  hasMore: boolean
  /** If this entity is a relationship, the triplet data (source, target, predicate) */
  triplet?: ArkeRelationship
}

export function createLoadedEntity(
  entity: ArkeEntity,
  relationships: ArkeRelationship[],
  outCursor: string | null = null,
  inCursor: string | null = null,
): LoadedEntity {
  const label = (entity.properties.label ?? entity.properties.title ?? entity.properties.name) as string | undefined
  const description = (entity.properties.description ?? entity.properties.body) as string | undefined
  return {
    entity, label, description: description?.slice(0, 200), relationships,
    outCursor, inCursor, hasMore: outCursor !== null || inCursor !== null,
  }
}

// Lightweight types for graph visualization
export interface GraphNode {
  id: string
  label: string
  type: string
  space_ids: string[]
}

export interface GraphEdge {
  id: string
  source_id: string
  target_id: string
  predicate: string
}

export interface ActivityItem {
  id: number | string
  entity_id: string
  actor_id: string
  action: string
  detail: unknown
  ts: string
}

export interface ArkeActor {
  id: string
  kind: string
  properties: Record<string, unknown>
  status: string
}

export interface ArkeSpace {
  id: string
  name: string
  description: string | null
  entity_count: number
}

export interface ArkeComment {
  id: string
  entity_id: string
  author_id: string
  body: string
  parent_id: string | null
  created_at: string
  replies?: ArkeComment[]
}
