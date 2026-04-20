// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react'
import { type ArkeInstanceClient } from '@/lib/arke-client'
import {
  type LoadedEntity,
  type ArkeSpace,
  type GraphNode,
  type GraphEdge,
  createLoadedEntity,
} from '@/lib/arke-types'

const POLL_INTERVAL = 3_000

export interface UseMapDataResult {
  nodes: Map<string, GraphNode>
  edges: GraphEdge[]
  spaces: ArkeSpace[]
  loading: boolean
  fetchRelationships: (id: string) => Promise<LoadedEntity | null>
  ensureEntity: (id: string) => Promise<void>
  resetView: () => void
}

export function useMapData(
  client: ArkeInstanceClient,
  nodeCap: number,
): UseMapDataResult {
  const [nodes, setNodes] = useState<Map<string, GraphNode>>(new Map())
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [spaces, setSpaces] = useState<ArkeSpace[]>([])
  const [loading, setLoading] = useState(true)
  const [resetCounter, setResetCounter] = useState(0)

  const lastActivityTsRef = useRef('')
  const abortRef = useRef<AbortController | null>(null)

  // ── Initial load: paginate /graph/data + fetch spaces, set state once ──
  useEffect(() => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac

    setLoading(true)

    async function load() {
      const startTs = new Date().toISOString()
      const allNodes = new Map<string, GraphNode>()
      let allEdges: GraphEdge[] = []
      let cursor: string | null = null

      try {
        // Fetch graph data and spaces in parallel
        const spacesPromise = client.getSpaces()

        do {
          if (ac.signal.aborted) return
          const result = await client.getGraphData({
            limit: nodeCap,
            cursor: cursor ?? undefined,
          })
          if (ac.signal.aborted) return

          for (const node of result.nodes) {
            if (allNodes.size >= nodeCap) break
            allNodes.set(node.id, node)
          }
          allEdges = allEdges.concat(result.edges)
          cursor = result.cursor
        } while (cursor && allNodes.size < nodeCap)

        if (ac.signal.aborted) return

        const fetchedSpaces = await spacesPromise
        if (ac.signal.aborted) return

        lastActivityTsRef.current = startTs
        setNodes(allNodes)
        setEdges(allEdges)
        setSpaces(fetchedSpaces)
      } catch (err) {
        console.error('Graph initial load failed:', err)
      } finally {
        if (!ac.signal.aborted) setLoading(false)
      }
    }

    load()
    return () => ac.abort()
  }, [client, nodeCap, resetCounter])

  // ── Poll for new entities and relationships ──
  useEffect(() => {
    if (loading) return

    const interval = setInterval(async () => {
      if (!lastActivityTsRef.current) return

      try {
        const result = await client.getActivitySince(lastActivityTsRef.current)
        if (result.activity.length === 0) return

        const latestTs = result.activity[0]?.ts
        if (latestTs) lastActivityTsRef.current = latestTs

        const newEntityIds = new Set<string>()
        const newEdges: GraphEdge[] = []

        for (const item of result.activity) {
          if (item.action === 'entity_created' || item.action === 'content_uploaded') {
            newEntityIds.add(item.entity_id)
          }
          if (item.action === 'relationship_created') {
            const raw = item.detail
            const detail: Record<string, unknown> | null =
              typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown> | null)
            if (detail?.relationship_id && detail?.target_id && detail?.predicate) {
              newEdges.push({
                id: detail.relationship_id as string,
                source_id: item.entity_id,
                target_id: detail.target_id as string,
                predicate: detail.predicate as string,
              })
            }
          }
        }

        // Fetch full entity for each new entity
        if (newEntityIds.size > 0) {
          const fetches = Array.from(newEntityIds).map(async (id) => {
            try {
              return await client.getEntity(id)
            } catch {
              return null
            }
          })
          const results = await Promise.all(fetches)

          setNodes((prev) => {
            const next = new Map(prev)
            for (const entity of results) {
              if (!entity || entity.kind === 'relationship') continue
              if (next.size >= nodeCap) break
              if (next.has(entity.id)) continue
              next.set(entity.id, {
                id: entity.id,
                label:
                  (entity.properties.label as string) ??
                  (entity.properties.title as string) ??
                  (entity.properties.name as string) ??
                  entity.type,
                type: entity.type,
                space_ids: entity.space_ids ?? [],
              })
            }
            return next
          })
        }

        if (newEdges.length > 0) {
          setEdges((prev) => {
            const existing = new Set(prev.map((e) => e.id))
            const additions = newEdges.filter((e) => !existing.has(e.id))
            return additions.length > 0 ? [...prev, ...additions] : prev
          })
        }
      } catch (err) {
        console.error('Graph polling error:', err)
      }
    }, POLL_INTERVAL)

    return () => clearInterval(interval)
  }, [loading, client, nodeCap])

  // ── On-demand: fetch relationships for EntityPanel ──
  const fetchRelationships = useCallback(
    async (id: string): Promise<LoadedEntity | null> => {
      try {
        const [entity, rels] = await Promise.all([
          client.getEntity(id),
          client.getRelationships(id),
        ])
        return createLoadedEntity(
          entity,
          rels.relationships,
          rels.outCursor,
          rels.inCursor,
          (entity as typeof entity & { _wikiDetail?: import('@/lib/arke-types').WikiDetail })._wikiDetail,
        )
      } catch (err) {
        console.error(`Failed to fetch relationships for ${id}:`, err)
        return null
      }
    },
    [client],
  )

  // ── Ensure a node exists in the graph (for URL deep-links) ──
  const ensureEntity = useCallback(
    async (id: string) => {
      try {
        const entity = await client.getEntity(id)
        if (entity.kind === 'relationship') return
        setNodes((prev) => {
          if (prev.has(id)) return prev
          const next = new Map(prev)
          next.set(id, {
            id: entity.id,
            label:
              (entity.properties.label as string) ??
              (entity.properties.title as string) ??
              (entity.properties.name as string) ??
              entity.type,
            type: entity.type,
            space_ids: entity.space_ids ?? [],
          })
          return next
        })
      } catch (err) {
        console.error(`Failed to ensure entity ${id}:`, err)
      }
    },
    [client],
  )

  // ── Reset ──
  const resetView = useCallback(() => {
    abortRef.current?.abort()
    setNodes(new Map())
    setEdges([])
    setSpaces([])
    lastActivityTsRef.current = ''
    setResetCounter((n) => n + 1)
  }, [])

  return { nodes, edges, spaces, loading, fetchRelationships, ensureEntity, resetView }
}
