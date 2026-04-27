// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ArkeClient } from '@/lib/arke-client'
import {
  type Entity,
  type Relationship,
  type Space,
  type LoadedEntity,
  createLoadedEntity,
} from '@/lib/arke-types'

export interface UseMapDataResult {
  entities: Map<string, Entity>
  relationships: Relationship[]
  spaces: Space[]
  loading: boolean
  fetchEntity: (id: string) => Promise<LoadedEntity | null>
  ensureEntity: (id: string) => Promise<void>
  resetView: () => void
}

export function useMapData(client: ArkeClient): UseMapDataResult {
  const [entities, setEntities] = useState<Map<string, Entity>>(new Map())
  const [relationships, setRelationships] = useState<Relationship[]>([])
  const [spaces, setSpaces] = useState<Space[]>([])
  const [loading, setLoading] = useState(true)
  const [resetCounter, setResetCounter] = useState(0)

  const abortRef = useRef<AbortController | null>(null)

  // ── Initial load: one call for entities+relationships, one for spaces ──
  useEffect(() => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac

    setLoading(true)

    async function load() {
      try {
        const [data, fetchedSpaces] = await Promise.all([
          client.fetchWikis(),
          client.fetchSpaces(),
        ])
        if (ac.signal.aborted) return

        const entityMap = new Map<string, Entity>()
        for (const e of data.wikis) {
          entityMap.set(e.id, e)
        }

        setEntities(entityMap)
        setRelationships(data.relationships)
        setSpaces(fetchedSpaces)
      } catch (err) {
        console.error('Graph initial load failed:', err)
      } finally {
        if (!ac.signal.aborted) setLoading(false)
      }
    }

    load()
    return () => ac.abort()
  }, [client, resetCounter])

  // ── On-demand: fetch entity detail for EntityPanel ──
  const fetchEntity = useCallback(
    async (id: string): Promise<LoadedEntity | null> => {
      try {
        const data = await client.fetchWiki(id)
        const entity: Entity = {
          id: data.id,
          space_id: data.space_id,
          type: data.type,
          label: data.label,
          source_path: data.source_path,
          properties: data.properties,
          created_at: data.created_at,
          updated_at: data.updated_at,
          content: (data as Entity).content,
        }
        return createLoadedEntity(entity, data.relationships.outgoing, data.relationships.incoming)
      } catch (err) {
        console.error(`Failed to fetch entity ${id}:`, err)
        return null
      }
    },
    [client],
  )

  // ── Ensure an entity exists in the graph (for URL deep-links) ──
  const ensureEntity = useCallback(
    async (id: string) => {
      if (entities.has(id)) return
      try {
        const data = await client.fetchWiki(id)
        setEntities((prev) => {
          if (prev.has(id)) return prev
          const next = new Map(prev)
          next.set(id, data)
          return next
        })
      } catch (err) {
        console.error(`Failed to ensure entity ${id}:`, err)
      }
    },
    [client, entities],
  )

  // ── Reset ──
  const resetView = useCallback(() => {
    abortRef.current?.abort()
    setEntities(new Map())
    setRelationships([])
    setSpaces([])
    setResetCounter((n) => n + 1)
  }, [])

  return { entities, relationships, spaces, loading, fetchEntity, ensureEntity, resetView }
}
