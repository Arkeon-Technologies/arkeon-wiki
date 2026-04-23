// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Graph from 'graphology'
import {
  SigmaContainer,
  useRegisterEvents,
  useSigma,
  useSetSettings,
} from '@react-sigma/core'
import '@react-sigma/core/lib/style.css'
import forceAtlas2 from 'graphology-layout-forceatlas2'

import type { ArkeClient } from '@/lib/arke-client'
import type { Entity, Relationship, Space, LoadedEntity } from '@/lib/arke-types'
import { useMapData, type UseMapDataResult } from '@/hooks/useMapData'
import { getEntitySpaceColor } from '@/lib/space-colors'
import { EntityPanel } from './EntityPanel'

const SPACE_NODE_PREFIX = '__space__'
const SPACE_EDGE_WEIGHT = 0.05
const SIZE_BASELINE = 80

function nodeSizeScale(nodeCount: number): number {
  if (nodeCount <= SIZE_BASELINE) return 1
  return Math.max(0.5, Math.sqrt(SIZE_BASELINE / nodeCount))
}

function neighborPosition(
  graph: Graph,
  relationships: Relationship[],
  nodeId: string,
  spaceId: string,
): { x: number; y: number } {
  const positions: { x: number; y: number }[] = []

  for (const rel of relationships) {
    const neighborId =
      rel.source_id === nodeId ? rel.target_id
      : rel.target_id === nodeId ? rel.source_id
      : null
    if (neighborId && graph.hasNode(neighborId)) {
      const a = graph.getNodeAttributes(neighborId)
      positions.push({ x: a.x, y: a.y })
    }
  }

  if (positions.length === 0 && spaceId) {
    const spaceNodeId = SPACE_NODE_PREFIX + spaceId
    if (graph.hasNode(spaceNodeId)) {
      const a = graph.getNodeAttributes(spaceNodeId)
      positions.push({ x: a.x, y: a.y })
    }
  }

  if (positions.length > 0) {
    const avgX = positions.reduce((s, p) => s + p.x, 0) / positions.length
    const avgY = positions.reduce((s, p) => s + p.y, 0) / positions.length
    return { x: avgX + (Math.random() - 0.5) * 20, y: avgY + (Math.random() - 0.5) * 20 }
  }

  let cx = 0, cy = 0, count = 0
  graph.forEachNode((_, a) => { cx += a.x; cy += a.y; count++ })
  if (count > 0) { cx /= count; cy /= count }
  const angle = Math.random() * Math.PI * 2
  const radius = Math.sqrt(Math.max(count, 1)) * 30 + 50
  return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius }
}

function hexWithAlpha(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255).toString(16).padStart(2, '0')
  return hex + a
}

// ---------------------------------------------------------------------------
// Inner component: sync data -> graphology, run layout, handle events
// ---------------------------------------------------------------------------

interface GraphEventsProps {
  data: UseMapDataResult
  relationships: Relationship[]
  spaces: Space[]
  selectId?: string
  selectedId: string | null
  onSelect: (id: string) => void
  onDeselect: () => void
  onEntitySelect?: (entityId: string) => void
}

function GraphSyncAndEvents({
  data,
  relationships,
  spaces,
  selectId,
  selectedId,
  onSelect,
  onDeselect,
  onEntitySelect,
}: GraphEventsProps) {
  const sigma = useSigma()
  const registerEvents = useRegisterEvents()
  const setSettings = useSetSettings()
  const { entities, loading } = data
  const layoutDoneRef = useRef(false)
  const hoveredNodeRef = useRef<string | null>(null)

  const spaceMap = useMemo(() => {
    const map = new Map<string, Space>()
    for (const s of spaces) map.set(s.id, s)
    return map
  }, [spaces])

  // ── Sync entities + relationships into graphology, run layout ──
  useEffect(() => {
    const graph = sigma.getGraph()

    if (loading && entities.size === 0) {
      graph.clear()
      layoutDoneRef.current = false
      sigma.getCamera().setState({ x: 0.5, y: 0.5, angle: 0, ratio: 1 })
      return
    }

    if (loading) return

    // Remove stale nodes
    const stale: string[] = []
    graph.forEachNode((id) => {
      if (id.startsWith(SPACE_NODE_PREFIX)) return
      if (!entities.has(id)) stale.push(id)
    })
    for (const id of stale) graph.dropNode(id)

    // Add new entity nodes
    const scale = nodeSizeScale(entities.size)
    let addedNodes = 0
    for (const [id, entity] of entities) {
      if (!graph.hasNode(id)) {
        const pos = layoutDoneRef.current
          ? neighborPosition(graph, relationships, id, entity.space_id)
          : { x: Math.random() * 200 - 100, y: Math.random() * 200 - 100 }
        graph.addNode(id, {
          x: pos.x,
          y: pos.y,
          size: 2 * scale,
          color: getEntitySpaceColor(entity.space_id),
          label: entity.label || entity.type,
          type: 'circle',
        })
        addedNodes++
      }
    }

    // Add new edges
    let addedEdges = 0
    for (const rel of relationships) {
      if (!graph.hasNode(rel.source_id) || !graph.hasNode(rel.target_id)) continue
      if (graph.hasEdge(rel.id)) continue
      try {
        graph.addEdgeWithKey(rel.id, rel.source_id, rel.target_id, {
          color: '#4a4a4a',
          size: 1,
          weight: 1,
          predicate: rel.predicate,
          type: 'line',
        })
        addedEdges++
      } catch { /* duplicate */ }
    }

    // ── Synthesize space nodes + membership edges ──
    const activeSpaces = new Map<string, string[]>()
    for (const [id, entity] of entities) {
      let members = activeSpaces.get(entity.space_id)
      if (!members) { members = []; activeSpaces.set(entity.space_id, members) }
      members.push(id)
    }

    for (const [spaceId, memberIds] of activeSpaces) {
      const spaceNodeId = SPACE_NODE_PREFIX + spaceId
      const space = spaceMap.get(spaceId)
      const spaceColor = getEntitySpaceColor(spaceId)

      if (!graph.hasNode(spaceNodeId)) {
        let sx = 0, sy = 0, count = 0
        for (const mid of memberIds) {
          if (graph.hasNode(mid)) {
            const a = graph.getNodeAttributes(mid)
            sx += a.x; sy += a.y; count++
          }
        }
        if (count > 0) { sx /= count; sy /= count }
        else { sx = Math.random() * 200 - 100; sy = Math.random() * 200 - 100 }

        graph.addNode(spaceNodeId, {
          x: sx, y: sy,
          size: 5 * scale,
          color: hexWithAlpha(spaceColor, 0.6),
          label: space?.name || spaceId.slice(0, 8),
          type: 'circle',
          isSpace: true,
        })
        addedNodes++
      }

      for (const memberId of memberIds) {
        const edgeKey = `${SPACE_NODE_PREFIX}${spaceId}__${memberId}`
        if (graph.hasEdge(edgeKey)) continue
        if (!graph.hasNode(memberId)) continue
        try {
          graph.addEdgeWithKey(edgeKey, spaceNodeId, memberId, {
            color: 'transparent',
            size: 0,
            weight: SPACE_EDGE_WEIGHT,
            type: 'line',
            hidden: true,
            isSpaceEdge: true,
          })
          addedEdges++
        } catch { /* duplicate */ }
      }
    }

    // Remove space nodes that no longer have members
    const spaceNodesToRemove: string[] = []
    graph.forEachNode((id) => {
      if (!id.startsWith(SPACE_NODE_PREFIX)) return
      const spaceId = id.slice(SPACE_NODE_PREFIX.length)
      if (!activeSpaces.has(spaceId)) spaceNodesToRemove.push(id)
    })
    for (const id of spaceNodesToRemove) graph.dropNode(id)

    if (graph.order === 0) return
    if (addedNodes === 0 && addedEdges === 0 && layoutDoneRef.current) return

    if (!layoutDoneRef.current) {
      layoutDoneRef.current = true

      // Build entity -> space mapping
      const entityToSpace = new Map<string, string>()
      for (const [id, entity] of entities) {
        entityToSpace.set(id, entity.space_id)
      }

      const spaceIds = new Set(entityToSpace.values())

      if (spaceIds.size >= 1) {
        // Per-space entity layout
        for (const sid of spaceIds) {
          const memberIds = Array.from(entityToSpace.entries())
            .filter(([, s]) => s === sid)
            .map(([id]) => id)
          if (memberIds.length <= 1) continue

          const sub = new Graph()
          const memberSet = new Set(memberIds)
          for (const mid of memberIds) {
            sub.addNode(mid, { x: Math.random() * 100 - 50, y: Math.random() * 100 - 50 })
          }
          for (const rel of relationships) {
            if (memberSet.has(rel.source_id) && memberSet.has(rel.target_id)) {
              try { sub.addEdgeWithKey(rel.id, rel.source_id, rel.target_id, { weight: 1 }) }
              catch { /* skip */ }
            }
          }

          if (sub.order > 1) {
            const subInferred = forceAtlas2.inferSettings(sub)
            const subIters = sub.order <= 50 ? 200 : sub.order <= 200 ? 150 : 80
            forceAtlas2.assign(sub, {
              iterations: subIters,
              settings: {
                ...subInferred,
                gravity: 0.01,
                scalingRatio: 20,
                barnesHutOptimize: sub.order > 500,
                edgeWeightInfluence: 1,
              },
            })
          }

          sub.forEachNode((nid, attrs) => {
            if (graph.hasNode(nid)) {
              graph.setNodeAttribute(nid, 'x', attrs.x)
              graph.setNodeAttribute(nid, 'y', attrs.y)
            }
          })

          const spaceNodeId = SPACE_NODE_PREFIX + sid
          if (graph.hasNode(spaceNodeId)) {
            graph.setNodeAttribute(spaceNodeId, 'x', 0)
            graph.setNodeAttribute(spaceNodeId, 'y', 0)
          }
        }
      }
    } else {
      // Incremental layout for new nodes
      const newNodes = new Set<string>()
      graph.forEachNode((id) => {
        if (!id.startsWith(SPACE_NODE_PREFIX) && !graph.getNodeAttribute(id, '_settled')) {
          newNodes.add(id)
        }
      })
      graph.forEachNode((id) => { graph.setNodeAttribute(id, '_settled', true) })

      if (newNodes.size > 0) {
        graph.forEachNode((id) => {
          if (!newNodes.has(id)) graph.setNodeAttribute(id, 'fixed', true)
        })
        const inferred = forceAtlas2.inferSettings(graph)
        forceAtlas2.assign(graph, {
          iterations: 30,
          settings: { ...inferred, gravity: 0.01, scalingRatio: 20, barnesHutOptimize: graph.order > 500, edgeWeightInfluence: 1 },
        })
        graph.forEachNode((id) => { graph.removeNodeAttribute(id, 'fixed') })
      }
    }
  }, [entities, relationships, spaces, loading, sigma, spaceMap])

  // ── Zoom to selected entity after layout ──
  useEffect(() => {
    if (!selectId || !layoutDoneRef.current) return
    const graph = sigma.getGraph()
    if (!graph.hasNode(selectId)) return

    sigma.refresh()
    const handler = () => {
      sigma.off('afterRender', handler)
      const d = sigma.getNodeDisplayData(selectId)
      if (!d) return
      sigma.getCamera().animate({ x: d.x, y: d.y, ratio: 0.1 }, { duration: 600 })
    }
    sigma.on('afterRender', handler)
    onSelect(selectId)
    return () => { sigma.off('afterRender', handler) }
  }, [selectId, loading, sigma, onSelect])

  // ── Click and hover events ──
  useEffect(() => {
    registerEvents({
      clickNode: ({ node }) => {
        if (node.startsWith(SPACE_NODE_PREFIX)) return
        onSelect(node)
        onEntitySelect?.(node)
      },
      clickStage: () => onDeselect(),
      enterNode: ({ node }) => {
        hoveredNodeRef.current = node
        sigma.refresh()
        const c = sigma.getContainer()
        if (c) c.style.cursor = node.startsWith(SPACE_NODE_PREFIX) ? 'default' : 'pointer'
      },
      leaveNode: () => {
        hoveredNodeRef.current = null
        sigma.refresh()
        const c = sigma.getContainer()
        if (c) c.style.cursor = 'default'
      },
    })
  }, [registerEvents, onSelect, onDeselect, onEntitySelect, sigma])

  // ── Node/edge reducers for selection + hover highlighting ──
  useEffect(() => {
    const graph = sigma.getGraph()
    const s = nodeSizeScale(graph.order)

    setSettings({
      nodeReducer: (node, attrs) => {
        const hNode = hoveredNodeRef.current
        if (!selectedId) {
          if (hNode === node) return { ...attrs, size: attrs.size + 1.5 * s, forceLabel: true }
          if (hNode && graph.hasNode(hNode) && graph.areNeighbors(node, hNode)) return { ...attrs, forceLabel: true }
          return attrs
        }
        if (!graph.hasNode(selectedId)) return attrs
        if (node === selectedId) return { ...attrs, size: 5 * s, color: '#ffffff', zIndex: 2, forceLabel: true }
        if (graph.areNeighbors(node, selectedId)) return { ...attrs, size: 3.5 * s, zIndex: 1, forceLabel: true }
        return { ...attrs, color: '#222222', size: 1.5 * s, zIndex: 0, label: null }
      },
      edgeReducer: (edge, attrs) => {
        if (!selectedId) return attrs
        if (!graph.hasNode(selectedId)) return attrs
        const source = graph.source(edge)
        const target = graph.target(edge)
        if (source === selectedId || target === selectedId)
          return { ...attrs, size: 1, color: attrs.color, zIndex: 1 }
        return { ...attrs, color: '#111111', size: 0.2, zIndex: 0 }
      },
    })
  }, [selectedId, sigma, setSettings])

  return null
}

// ---------------------------------------------------------------------------
// MapView
// ---------------------------------------------------------------------------

interface MapViewProps {
  client: ArkeClient
  selectId?: string
  onEntitySelect?: (entityId: string) => void
  onEntityDeselect?: () => void
}

export function MapView({
  client,
  selectId,
  onEntitySelect,
  onEntityDeselect,
}: MapViewProps) {
  const data = useMapData(client)
  const { entities, relationships, spaces, loading, fetchEntity, ensureEntity, resetView } = data

  const [selectedId, setSelectedId] = useState<string | null>(selectId ?? null)
  const [selectedEntity, setSelectedEntity] = useState<LoadedEntity | null>(null)
  const lastSelectIdRef = useRef<string | undefined>(selectId)

  const selectEntity = useCallback(
    async (id: string) => {
      setSelectedId(id)
      onEntitySelect?.(id)
      lastSelectIdRef.current = id
      const loaded = await fetchEntity(id)
      if (loaded) setSelectedEntity(loaded)
    },
    [fetchEntity, onEntitySelect],
  )

  useEffect(() => {
    if (selectId && selectId !== lastSelectIdRef.current) {
      ensureEntity(selectId).then(() => selectEntity(selectId))
    }
  }, [selectId, ensureEntity, selectEntity])

  const loadedEntityIds = useMemo(() => new Set(entities.keys()), [entities])

  return (
    <div className="w-full h-full bg-[#0a0a0a] relative" style={{ paddingTop: '40px' }}>
      <SigmaContainer
        graph={Graph}
        style={{ width: '100%', height: '100%', background: '#0a0a0a' }}
        settings={{
          allowInvalidContainer: true,
          renderLabels: true,
          labelRenderedSizeThreshold: 8,
          labelColor: { color: '#a1a1aa' },
          labelFont: 'Inter, system-ui, sans-serif',
          labelSize: 11,
          defaultNodeColor: '#d4d4d8',
          defaultEdgeColor: '#222222',
          defaultEdgeType: 'line',
          zIndex: true,
          minCameraRatio: 0.005,
          maxCameraRatio: 15,
        }}
      >
        <GraphSyncAndEvents
          data={data}
          relationships={relationships}
          spaces={spaces}
          selectId={selectId}
          selectedId={selectedId}
          onSelect={selectEntity}
          onDeselect={() => {
            setSelectedId(null)
            setSelectedEntity(null)
            onEntityDeselect?.()
          }}
          onEntitySelect={onEntitySelect}
        />
      </SigmaContainer>

      {loading && (
        <div className="absolute top-14 left-3 px-3 py-1.5 bg-zinc-800/90 rounded text-xs text-zinc-400 z-10">
          Loading...
        </div>
      )}

      {!loading && (
        <div className="absolute top-14 left-3 flex items-center gap-2 z-10">
          <div className="px-3 py-1.5 bg-zinc-800/90 rounded text-xs text-zinc-400">
            {entities.size} entities
          </div>
          <button
            onClick={() => {
              setSelectedId(null)
              setSelectedEntity(null)
              onEntityDeselect?.()
              resetView()
            }}
            className="px-2.5 py-1.5 bg-zinc-800/90 rounded text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            title="Reload graph"
          >
            Reset
          </button>
        </div>
      )}

      {selectedId && selectedEntity && (
        <EntityPanel
          entity={selectedEntity}
          loadedEntityIds={loadedEntityIds}
          onNavigate={selectEntity}
          onClose={() => {
            setSelectedId(null)
            setSelectedEntity(null)
            onEntityDeselect?.()
          }}
        />
      )}
    </div>
  )
}
