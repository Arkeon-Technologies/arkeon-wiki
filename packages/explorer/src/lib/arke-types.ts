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

/** A reference link from the single-wiki endpoint */
export interface WikiLink {
  id: string
  label: string
  type: string
  predicate: string
  span_text?: string
}

/** Extended data returned by GET /wiki/:id for wiki-type entities */
export interface WikiDetail {
  links_to: WikiLink[]
  linked_from: WikiLink[]
  sources: unknown[]
}

export interface LoadedEntity {
  entity: ArkeEntity
  label?: string
  description?: string
  relationships: ArkeRelationship[]
  outCursor: string | null
  inCursor: string | null
  hasMore: boolean
  triplet?: ArkeRelationship
  /** Wiki-specific detail (links_to, linked_from) from the single-wiki endpoint */
  wikiDetail?: WikiDetail
}

export function createLoadedEntity(
  entity: ArkeEntity,
  relationships: ArkeRelationship[],
  outCursor: string | null = null,
  inCursor: string | null = null,
  wikiDetail?: WikiDetail,
): LoadedEntity {
  const label = (entity.properties.label ?? entity.properties.title ?? entity.properties.name) as string | undefined
  const description = (entity.properties.short_description ?? entity.properties.description ?? entity.properties.body) as string | undefined
  return {
    entity, label, description, relationships,
    outCursor, inCursor, hasMore: outCursor !== null || inCursor !== null,
    wikiDetail,
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
