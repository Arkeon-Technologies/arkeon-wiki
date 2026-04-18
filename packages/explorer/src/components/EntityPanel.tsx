// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useRef } from 'react'
import { type LoadedEntity, type ArkeRelationship, type ArkeComment } from '@/lib/arke-types'
import { type ArkeInstanceClient } from '@/lib/arke-client'
import { getTypeColor } from '@/lib/type-colors'

interface EntityPanelProps {
  entity: LoadedEntity
  loadedEntityIds: Set<string>
  client: ArkeInstanceClient
  onNavigate: (entityId: string) => void
  onLoadMore: () => void
  onClose: () => void
}

function getPeerInfo(rel: ArkeRelationship, entityId: string) {
  const isSource = rel.source_id === entityId
  const peerId = isSource ? rel.target_id : rel.source_id
  const peer = isSource ? rel.target : rel.source
  const props = peer?.properties || {}
  return {
    id: peerId,
    label: (props.label ?? props.title ?? props.name) as string | undefined,
    type: peer?.type,
  }
}

/** Parse relationship properties which may be a JSON string or object */
function parseRelProps(props: string | Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!props) return null
  if (typeof props === 'string') {
    if (props === '{}' || props === '') return null
    try {
      const parsed = JSON.parse(props)
      if (typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0) return parsed
      return null
    } catch {
      return null
    }
  }
  if (typeof props === 'object' && Object.keys(props).length > 0) return props
  return null
}

type RelItem = { rel: ArkeRelationship; peer: { id: string; label?: string; type?: string } }

function RelationshipRow({
  rel,
  peer,
  isLoaded,
  onNavigate,
}: {
  rel: ArkeRelationship
  peer: { id: string; label?: string; type?: string }
  isLoaded: boolean
  onNavigate: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const peerLabel = peer.label || peer.id.slice(0, 16)
  const peerColor = peer.type ? getTypeColor(peer.type) : '#71717a'
  const relProps = parseRelProps(rel.properties)
  const hasDetail = relProps !== null

  return (
    <div>
      <div className="flex items-center gap-1">
        {/* Expand toggle -- only if relationship has properties */}
        {hasDetail ? (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
            className="text-zinc-500 hover:text-zinc-300 p-0.5 shrink-0 transition-colors"
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            <svg
              width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"
              style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
            >
              <path d="M4 2l4 4-4 4" />
            </svg>
          </button>
        ) : (
          <span className="w-[16px] shrink-0" />
        )}

        {/* Navigate to peer entity (default click target) */}
        <button
          onClick={() => onNavigate(peer.id)}
          className={`flex-1 flex items-center gap-2 px-1.5 py-1.5 rounded text-left hover:bg-zinc-800 transition-colors min-w-0 ${
            isLoaded ? '' : 'opacity-60'
          }`}
        >
          {!isLoaded && (
            <span className="text-blue-400 text-xs font-bold shrink-0">+</span>
          )}
          {peer.type && (
            <span
              className="text-[9px] font-semibold uppercase px-1 py-0.5 rounded shrink-0"
              style={{ backgroundColor: peerColor + '33', color: peerColor }}
            >
              {peer.type}
            </span>
          )}
          <span className="text-sm text-zinc-300 truncate">{peerLabel}</span>
        </button>
      </div>

      {/* Expanded relationship detail */}
      {expanded && relProps && (
        <div className="ml-[16px] mt-1 mb-2 px-3 py-2 bg-zinc-800/50 rounded border border-zinc-700/50">
          <div className="space-y-1.5">
            {Object.entries(relProps).map(([key, value]) => (
              <div key={key}>
                <span className="text-[10px] text-zinc-500 uppercase tracking-wide">{key}</span>
                <p className="text-xs text-zinc-300 break-words">
                  {typeof value === 'string'
                    ? value.length > 500 ? value.slice(0, 500) + '...' : value
                    : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '')}
                </p>
              </div>
            ))}
          </div>
          <button
            onClick={() => onNavigate(rel.id)}
            className="mt-2 pt-1.5 border-t border-zinc-700/50 w-full text-left hover:opacity-80 transition-opacity group"
            title="View this relationship as an entity"
          >
            <span className="text-[10px] text-zinc-600 uppercase tracking-wide">Relationship</span>
            <div className="text-[10px] text-zinc-500 font-mono group-hover:text-zinc-300 transition-colors">
              {rel.id} &rarr;
            </div>
          </button>
        </div>
      )}
    </div>
  )
}

function TripletEntityCard({
  entity,
  entityId,
  onNavigate,
}: {
  entity?: { id: string; kind: string; type: string; properties: Record<string, unknown> }
  entityId: string
  onNavigate: (id: string) => void
}) {
  const label = entity
    ? ((entity.properties.label ?? entity.properties.title ?? entity.properties.name) as string | undefined)
    : undefined
  const type = entity?.type
  const color = type ? getTypeColor(type) : '#71717a'

  return (
    <button
      onClick={() => onNavigate(entityId)}
      className="w-full px-3 py-2.5 rounded bg-zinc-800/60 border border-zinc-700/50 hover:border-zinc-600 text-left transition-colors"
    >
      {type && (
        <span
          className="inline-block text-[9px] font-semibold uppercase px-1 py-0.5 rounded"
          style={{ backgroundColor: color + '33', color }}
        >
          {type}
        </span>
      )}
      <p className="text-sm text-zinc-300 mt-1 truncate">{label || entityId.slice(0, 16)}</p>
      <p className="text-[10px] text-zinc-600 font-mono mt-0.5">{entityId}</p>
    </button>
  )
}

function RelationshipGroup({
  groups,
  loadedEntityIds,
  onNavigate,
}: {
  groups: Map<string, RelItem[]>
  loadedEntityIds: Set<string>
  onNavigate: (id: string) => void
}) {
  return (
    <div className="space-y-3">
      {Array.from(groups.entries()).map(([predicate, items]) => (
        <div key={predicate}>
          <span className="text-xs text-zinc-500 font-medium">{predicate.replace(/_/g, ' ')}</span>
          <div className="mt-1 space-y-0.5">
            {items.map(({ rel, peer }) => (
              <RelationshipRow
                key={rel.id}
                rel={rel}
                peer={peer}
                isLoaded={loadedEntityIds.has(peer.id)}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function relativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

function CommentsSection({ entityId, client }: { entityId: string; client: ArkeInstanceClient }) {
  const [comments, setComments] = useState<ArkeComment[]>([])
  const [loading, setLoading] = useState(true)
  const [cursor, setCursor] = useState<string | null>(null)
  const [authorLabels, setAuthorLabels] = useState<Map<string, string>>(new Map())
  const resolvedAuthors = useRef(new Set<string>())

  useEffect(() => {
    setLoading(true)
    setComments([])
    setCursor(null)
    resolvedAuthors.current.clear()
    client.getComments(entityId)
      .then(data => {
        setComments(data.comments)
        setCursor(data.cursor)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [client, entityId])

  // Resolve author labels
  useEffect(() => {
    const allAuthors = new Set<string>()
    for (const c of comments) {
      allAuthors.add(c.author_id)
      for (const r of c.replies || []) allAuthors.add(r.author_id)
    }
    for (const id of allAuthors) {
      if (resolvedAuthors.current.has(id)) continue
      resolvedAuthors.current.add(id)
      client.getActor(id).then(actor => {
        const label = (actor.properties?.label ?? actor.properties?.name) as string | undefined
        if (label) setAuthorLabels(prev => new Map(prev).set(id, label))
      }).catch(() => {})
    }
  }, [client, comments])

  const loadMore = () => {
    if (!cursor) return
    client.getComments(entityId, cursor).then(data => {
      setComments(prev => [...prev, ...data.comments])
      setCursor(data.cursor)
    }).catch(() => {})
  }

  if (loading) return <p className="text-xs text-zinc-500 px-4 py-2">Loading comments...</p>
  if (comments.length === 0) return <p className="text-xs text-zinc-600 px-4 py-2">No comments</p>

  const renderComment = (comment: ArkeComment, isReply = false) => (
    <div key={comment.id} className={isReply ? 'ml-4 border-l border-zinc-800 pl-3' : ''}>
      <div className="flex items-baseline gap-2 mb-0.5">
        <span className="text-xs font-medium text-zinc-300">
          {authorLabels.get(comment.author_id) || comment.author_id.slice(0, 8)}
        </span>
        <span className="text-[10px] text-zinc-600">{relativeTime(comment.created_at)}</span>
      </div>
      <p className="text-sm text-zinc-400 whitespace-pre-wrap break-words">{comment.body}</p>
    </div>
  )

  return (
    <div className="space-y-3">
      {comments.map(comment => (
        <div key={comment.id} className="space-y-2">
          {renderComment(comment)}
          {comment.replies?.map(reply => renderComment(reply, true))}
        </div>
      ))}
      {cursor && (
        <button
          onClick={loadMore}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Load more comments...
        </button>
      )}
    </div>
  )
}

export function EntityPanel({ entity, loadedEntityIds, client, onNavigate, onLoadMore, onClose }: EntityPanelProps) {
  const color = getTypeColor(entity.entity.type)
  const label = entity.label
    || (entity.triplet ? entity.triplet.predicate.replace(/_/g, ' ') : null)
    || entity.entity.id.slice(0, 16)
  const description = entity.description

  const entityId = entity.entity.id

  // Split relationships into outgoing and incoming, grouped by predicate
  const outgoing = new Map<string, RelItem[]>()
  const incoming = new Map<string, RelItem[]>()

  for (const rel of entity.relationships) {
    const peer = getPeerInfo(rel, entityId)
    const isOutgoing = rel.source_id === entityId
    const map = isOutgoing ? outgoing : incoming
    const group = map.get(rel.predicate) || []
    group.push({ rel, peer })
    map.set(rel.predicate, group)
  }

  // Properties to skip (already shown in header)
  const skipProps = new Set(['label', 'description', 'name', 'title', 'body'])

  const parsedProps = parseRelProps(entity.entity.properties) || {}
  const properties = Object.entries(parsedProps).filter(
    ([key]) => !skipProps.has(key)
  )

  return (
    <div className="absolute right-0 top-0 h-full w-[380px] bg-zinc-900 border-l border-zinc-800 overflow-y-auto z-50">
      {/* Header */}
      <div className="sticky top-0 bg-zinc-900 border-b border-zinc-800 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <span
              className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide mb-2"
              style={{ backgroundColor: color + '33', color }}
            >
              {entity.entity.type}
            </span>
            <h2 className="text-lg font-semibold text-white truncate">{label}</h2>
            {description && (
              <p className="text-sm text-zinc-400 mt-1">{description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-white transition-colors p-1 shrink-0"
            aria-label="Close panel"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      </div>

      {/* Triplet view for relationship entities */}
      {entity.triplet && (
        <div className="p-4 border-b border-zinc-800">
          <h3 className="text-xs font-semibold uppercase text-zinc-500 tracking-wide mb-3">Relationship</h3>
          <div className="flex flex-col gap-2">
            <TripletEntityCard
              entity={entity.triplet.source}
              entityId={entity.triplet.source_id}
              onNavigate={onNavigate}
            />
            <div className="flex items-center gap-1.5 px-2 text-zinc-500">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M6 2v8M3 7l3 3 3-3" />
              </svg>
              <span className="text-xs font-medium">{entity.triplet.predicate.replace(/_/g, ' ')}</span>
            </div>
            <TripletEntityCard
              entity={entity.triplet.target}
              entityId={entity.triplet.target_id}
              onNavigate={onNavigate}
            />
          </div>
        </div>
      )}

      {/* Properties */}
      {properties.length > 0 && (
        <div className="p-4 border-b border-zinc-800">
          <h3 className="text-xs font-semibold uppercase text-zinc-500 tracking-wide mb-3">Properties</h3>
          <div className="space-y-2">
            {properties.map(([key, value]) => (
              <div key={key}>
                <span className="text-xs text-zinc-500">{key}</span>
                <p className="text-sm text-zinc-300 break-all">
                  {typeof value === 'string'
                    ? value.length > 300 ? value.slice(0, 300) + '...' : value
                    : typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Outgoing Relationships */}
      {outgoing.size > 0 && (
        <div className="p-4 border-b border-zinc-800">
          <h3 className="text-xs font-semibold uppercase text-zinc-500 tracking-wide mb-3">
            <span className="text-zinc-400 mr-1.5">&rarr;</span>
            Outgoing ({Array.from(outgoing.values()).reduce((n, g) => n + g.length, 0)})
          </h3>
          <RelationshipGroup groups={outgoing} loadedEntityIds={loadedEntityIds} onNavigate={onNavigate} />
        </div>
      )}

      {/* Incoming Relationships */}
      {incoming.size > 0 && (
        <div className="p-4 border-b border-zinc-800">
          <h3 className="text-xs font-semibold uppercase text-zinc-500 tracking-wide mb-3">
            <span className="text-zinc-400 mr-1.5">&larr;</span>
            Incoming ({Array.from(incoming.values()).reduce((n, g) => n + g.length, 0)})
          </h3>
          <RelationshipGroup groups={incoming} loadedEntityIds={loadedEntityIds} onNavigate={onNavigate} />
        </div>
      )}

      {/* Load more relationships */}
      {entity.hasMore && (
        <div className="px-4 py-3 border-b border-zinc-800">
          <button
            onClick={onLoadMore}
            className="w-full px-3 py-2 text-xs text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-600 rounded transition-colors"
          >
            Load more relationships...
          </button>
        </div>
      )}

      {/* Comments */}
      <div className="p-4 border-b border-zinc-800">
        <h3 className="text-xs font-semibold uppercase text-zinc-500 tracking-wide mb-3">Comments</h3>
        <CommentsSection entityId={entity.entity.id} client={client} />
      </div>

      {/* Footer */}
      <div className="p-4">
        <div className="space-y-1">
          <div>
            <span className="text-xs text-zinc-500">Entity ID</span>
            <p className="text-xs font-mono text-zinc-400 break-all">{entity.entity.id}</p>
          </div>
          <div>
            <span className="text-xs text-zinc-500">Created</span>
            <p className="text-xs text-zinc-400">{new Date(entity.entity.created_at).toLocaleString()}</p>
          </div>
          <div>
            <span className="text-xs text-zinc-500">Version</span>
            <p className="text-xs text-zinc-400">{entity.entity.ver}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
