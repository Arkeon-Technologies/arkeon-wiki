// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface Entity {
  id: string
  space_id: string
  type: string
  label: string
  source_path: string
  properties: string | Record<string, unknown>
  created_at: string
  updated_at: string
  content?: string | null
}

export interface Relationship {
  id: string
  source_id: string
  target_id: string
  predicate: string
  link_text?: string
  link_path?: string
}

export interface OutgoingRel extends Relationship {
  target_label: string
  target_type: string
  target_source_path: string
}

export interface IncomingRel extends Relationship {
  source_label: string
  source_type: string
  source_source_path: string
}

export interface Space {
  id: string
  name: string
  watch_dir: string
  entity_count: number
  created_at: string
}

export interface LoadedEntity {
  entity: Entity
  label: string
  description: string
  outgoing: OutgoingRel[]
  incoming: IncomingRel[]
  content: string | null
}

export function parseProps(entity: Entity): Record<string, unknown> {
  if (typeof entity.properties === 'string') {
    try { return JSON.parse(entity.properties) } catch { return {} }
  }
  return entity.properties ?? {}
}

export function createLoadedEntity(
  entity: Entity,
  outgoing: OutgoingRel[],
  incoming: IncomingRel[],
): LoadedEntity {
  const props = parseProps(entity)
  const label = (props.label ?? entity.label) as string
  const description = (props.short_description ?? props.description ?? '') as string
  const content = entity.content ?? null

  return { entity, label, description, outgoing, incoming, content }
}
