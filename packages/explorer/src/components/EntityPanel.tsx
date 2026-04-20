// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState, useRef, useCallback } from 'react'
import { type LoadedEntity, type ArkeRelationship, type WikiLink } from '@/lib/arke-types'
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Wiki content renderer
// ---------------------------------------------------------------------------

function WikiContent({
  content,
  linksTo,
  onNavigate,
}: {
  content: string
  linksTo: WikiLink[]
  onNavigate: (id: string) => void
}) {
  const labelMap = new Map<string, string>()
  for (const link of linksTo) {
    labelMap.set(link.id, link.label)
  }

  const containerRef = useRef<HTMLDivElement>(null)

  const scrollToSection = useCallback((slug: string) => {
    const el = containerRef.current?.querySelector(`[data-section="${slug}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  function inlineRender(text: string, keyPrefix: string): React.ReactNode[] {
    const tokenRegex = /\[\[entity:([A-Z0-9]+)\]\]|\*\*(.+?)\*\*/g
    const nodes: React.ReactNode[] = []
    let last = 0
    let m: RegExpExecArray | null
    let idx = 0

    while ((m = tokenRegex.exec(text)) !== null) {
      if (m.index > last) nodes.push(text.slice(last, m.index))
      if (m[1]) {
        const id = m[1]
        nodes.push(
          <button
            key={`${keyPrefix}-l${idx++}`}
            onClick={() => onNavigate(id)}
            className="text-blue-400 hover:text-blue-300 underline underline-offset-2 decoration-blue-400/40 hover:decoration-blue-300/60 transition-colors inline cursor-pointer"
          >
            {labelMap.get(id) || id.slice(0, 8) + '...'}
          </button>,
        )
      } else if (m[2]) {
        nodes.push(
          <strong key={`${keyPrefix}-b${idx++}`} className="text-zinc-200 font-semibold">
            {m[2]}
          </strong>,
        )
      }
      last = m.index + m[0].length
    }
    if (last < text.length) nodes.push(text.slice(last))
    return nodes
  }

  const lines = content.split('\n')
  const headings: Array<{ title: string; slug: string }> = []
  const blocks: JSX.Element[] = []
  let paraLines: string[] = []
  let blockIdx = 0

  const flushPara = () => {
    if (paraLines.length > 0) {
      const joined = paraLines.join(' ')
      if (joined.trim()) {
        blocks.push(
          <p key={`b${blockIdx++}`} className="mb-4 last:mb-0">
            {inlineRender(joined, `p${blockIdx}`)}
          </p>,
        )
      }
      paraLines = []
    }
  }

  for (const line of lines) {
    if (line.startsWith('## ')) {
      flushPara()
      const title = line.slice(3)
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
      headings.push({ title, slug })
      blocks.push(
        <h3
          key={`b${blockIdx++}`}
          data-section={slug}
          className="text-[15px] font-semibold text-zinc-100 mt-7 mb-3 pb-1.5 border-b border-zinc-700/60"
        >
          {title}
        </h3>,
      )
    } else if (line.trim() === '') {
      flushPara()
    } else {
      paraLines.push(line)
    }
  }
  flushPara()

  return (
    <div ref={containerRef}>
      {/* Table of contents */}
      {headings.length > 1 && (
        <nav className="mb-5 pl-3 border-l-2 border-zinc-700/60">
          <p className="text-[11px] font-semibold uppercase text-zinc-500 tracking-wider mb-1.5">
            Contents
          </p>
          <div className="flex flex-col gap-0.5">
            {headings.map((h) => (
              <button
                key={h.slug}
                onClick={() => scrollToSection(h.slug)}
                className="text-[13px] text-zinc-500 hover:text-zinc-200 cursor-pointer transition-colors text-left py-0.5"
              >
                {h.title}
              </button>
            ))}
          </div>
        </nav>
      )}

      {/* Article body */}
      <div className="text-[15px] text-zinc-300 leading-[1.8]">
        {blocks}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Reference link list
// ---------------------------------------------------------------------------

function ReferenceList({
  links,
  onNavigate,
}: {
  links: WikiLink[]
  onNavigate: (id: string) => void
}) {
  return (
    <div className="space-y-1">
      {links.map((link) => {
        const color = getTypeColor(link.type)
        return (
          <button
            key={link.id}
            onClick={() => onNavigate(link.id)}
            className="w-full flex items-center gap-2.5 px-2 py-2 rounded text-left hover:bg-zinc-800/60 transition-colors cursor-pointer"
          >
            <span
              className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded shrink-0"
              style={{ backgroundColor: color + '18', color }}
            >
              {link.type}
            </span>
            <span className="text-[14px] text-zinc-300 truncate">{link.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Relationship section (non-wiki entities)
// ---------------------------------------------------------------------------

type RelItem = {
  rel: ArkeRelationship
  peer: { id: string; label?: string; type?: string }
}

function RelationshipSection({
  outgoing,
  incoming,
  loadedEntityIds,
  onNavigate,
}: {
  outgoing: Map<string, RelItem[]>
  incoming: Map<string, RelItem[]>
  loadedEntityIds: Set<string>
  onNavigate: (id: string) => void
}) {
  const total =
    Array.from(outgoing.values()).reduce((n, g) => n + g.length, 0) +
    Array.from(incoming.values()).reduce((n, g) => n + g.length, 0)
  if (total === 0) return null

  const renderGroup = (items: RelItem[], predicate: string, prefix: string) => (
    <div key={`${prefix}-${predicate}`}>
      <span className="text-[12px] text-zinc-500 font-medium">
        {predicate.replace(/_/g, ' ')}
      </span>
      <div className="mt-1 space-y-0.5">
        {items.map(({ peer }) => {
          const peerColor = peer.type ? getTypeColor(peer.type) : '#71717a'
          const isLoaded = loadedEntityIds.has(peer.id)
          return (
            <button
              key={peer.id}
              onClick={() => onNavigate(peer.id)}
              className={`w-full flex items-center gap-2.5 px-2 py-2 rounded text-left hover:bg-zinc-800/60 transition-colors cursor-pointer ${
                isLoaded ? '' : 'opacity-60'
              }`}
            >
              {!isLoaded && (
                <span className="text-blue-400 text-xs font-bold shrink-0">+</span>
              )}
              {peer.type && (
                <span
                  className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded shrink-0"
                  style={{ backgroundColor: peerColor + '18', color: peerColor }}
                >
                  {peer.type}
                </span>
              )}
              <span className="text-[14px] text-zinc-300 truncate">
                {peer.label || peer.id.slice(0, 16)}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )

  return (
    <div className="space-y-4">
      {Array.from(outgoing.entries()).map(([p, items]) => renderGroup(items, p, 'out'))}
      {Array.from(incoming.entries()).map(([p, items]) => renderGroup(items, 'referenced by', 'in'))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Triplet view
// ---------------------------------------------------------------------------

function TripletView({
  triplet,
  onNavigate,
}: {
  triplet: ArkeRelationship
  onNavigate: (id: string) => void
}) {
  const sourceProps = triplet.source?.properties || {}
  const targetProps = triplet.target?.properties || {}
  const sourceLabel = (sourceProps.label ?? sourceProps.title ?? sourceProps.name) as string | undefined
  const targetLabel = (targetProps.label ?? targetProps.title ?? targetProps.name) as string | undefined
  const sourceColor = triplet.source?.type ? getTypeColor(triplet.source.type) : '#71717a'
  const targetColor = triplet.target?.type ? getTypeColor(triplet.target.type) : '#71717a'

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={() => onNavigate(triplet.source_id)}
        className="w-full px-4 py-3 rounded-lg bg-zinc-800/40 border border-zinc-700/30 hover:border-zinc-600 text-left transition-colors cursor-pointer"
      >
        {triplet.source?.type && (
          <span
            className="inline-block text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded"
            style={{ backgroundColor: sourceColor + '18', color: sourceColor }}
          >
            {triplet.source.type}
          </span>
        )}
        <p className="text-[14px] text-zinc-300 mt-1 truncate">{sourceLabel || triplet.source_id.slice(0, 16)}</p>
      </button>
      <div className="flex items-center gap-1.5 px-3 text-zinc-500">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M6 2v8M3 7l3 3 3-3" />
        </svg>
        <span className="text-[12px] font-medium">{triplet.predicate.replace(/_/g, ' ')}</span>
      </div>
      <button
        onClick={() => onNavigate(triplet.target_id)}
        className="w-full px-4 py-3 rounded-lg bg-zinc-800/40 border border-zinc-700/30 hover:border-zinc-600 text-left transition-colors cursor-pointer"
      >
        {triplet.target?.type && (
          <span
            className="inline-block text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded"
            style={{ backgroundColor: targetColor + '18', color: targetColor }}
          >
            {triplet.target.type}
          </span>
        )}
        <p className="text-[14px] text-zinc-300 mt-1 truncate">{targetLabel || triplet.target_id.slice(0, 16)}</p>
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Collapsible section
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-zinc-800/60">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-7 py-3.5 hover:bg-zinc-800/20 transition-colors"
      >
        <h3 className="text-[12px] font-semibold uppercase text-zinc-500 tracking-wider">
          {title}
        </h3>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-zinc-600"
          style={{
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.15s',
          }}
        >
          <path d="M3 1l4 4-4 4" />
        </svg>
      </button>
      {open && <div className="px-7 pb-5">{children}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main panel — "Wikipedia Clean" layout
// ---------------------------------------------------------------------------

export function EntityPanel({
  entity,
  loadedEntityIds,
  client,
  onNavigate,
  onLoadMore,
  onClose,
}: EntityPanelProps) {
  const props = entity.entity.properties
  const color = getTypeColor(entity.entity.type)
  const isWiki = entity.entity.type === 'wiki'

  const label =
    entity.label ||
    (entity.triplet ? entity.triplet.predicate.replace(/_/g, ' ') : null) ||
    entity.entity.id.slice(0, 16)

  const shortDesc = (props.short_description as string) || entity.description || ''
  const content = (props.content as string) || ''
  const aliases = (props.aliases as string[]) || []
  const keywords = (props.keywords as string[]) || []
  const subjectType = (props.subject_type as string) || ''
  const status = (props.status as string) || ''
  const description = (props.description as string) || ''

  const wikiDetail = entity.wikiDetail
  const linksTo = wikiDetail?.links_to ?? []
  const linkedFrom = wikiDetail?.linked_from ?? []

  const entityId = entity.entity.id

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

  return (
    <div
      className="absolute right-0 top-0 h-full bg-zinc-900 border-l border-zinc-800 overflow-y-auto z-50 flex flex-col"
      style={{ width: '45%', minWidth: '480px', maxWidth: '720px' }}
    >
      {/* ── Header ── */}
      <div className="sticky top-0 bg-zinc-900/95 backdrop-blur-sm border-b border-zinc-800 z-10">
        <div className="px-7 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              {/* Badges */}
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <span
                  className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide"
                  style={{ backgroundColor: color + '18', color }}
                >
                  {entity.entity.type}
                </span>
                {subjectType && (
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wide">
                    {subjectType}
                  </span>
                )}
                {status && (
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-medium ${
                      status === 'published'
                        ? 'text-emerald-400 bg-emerald-400/10'
                        : 'text-amber-400 bg-amber-400/10'
                    }`}
                  >
                    {status}
                  </span>
                )}
              </div>

              {/* Title */}
              <h2 className="text-xl font-bold text-white leading-snug">
                {label}
              </h2>

              {/* Description */}
              {shortDesc && (
                <p className="text-[15px] text-zinc-400 mt-2 leading-relaxed">
                  {shortDesc}
                </p>
              )}
              {!shortDesc && description && (
                <p className="text-[15px] text-zinc-400 mt-2 leading-relaxed">
                  {description}
                </p>
              )}

              {/* Aliases */}
              {aliases.length > 0 && (
                <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                  {aliases.map((a) => (
                    <span
                      key={a}
                      className="text-[12px] text-zinc-500 bg-zinc-800/80 px-2 py-0.5 rounded"
                    >
                      {a}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Close button */}
            <button
              onClick={onClose}
              className="text-zinc-600 hover:text-white transition-colors p-1.5 shrink-0 mt-0.5 rounded hover:bg-zinc-800/50"
              aria-label="Close panel"
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1">
        {/* Triplet view for relationship entities */}
        {entity.triplet && (
          <Section title="Relationship">
            <TripletView triplet={entity.triplet} onNavigate={onNavigate} />
          </Section>
        )}

        {/* Wiki article content */}
        {isWiki && content && (
          <Section title="Article">
            <WikiContent content={content} linksTo={linksTo} onNavigate={onNavigate} />
          </Section>
        )}

        {/* References */}
        {linksTo.length > 0 && (
          <Section title={`References (${linksTo.length})`} defaultOpen={!isWiki}>
            <ReferenceList links={linksTo} onNavigate={onNavigate} />
          </Section>
        )}

        {/* Referenced by */}
        {linkedFrom.length > 0 && (
          <Section title={`Referenced by (${linkedFrom.length})`} defaultOpen={false}>
            <ReferenceList links={linkedFrom} onNavigate={onNavigate} />
          </Section>
        )}

        {/* Relationships (non-wiki) */}
        {!isWiki && (outgoing.size > 0 || incoming.size > 0) && (
          <Section
            title={`Connections (${
              Array.from(outgoing.values()).reduce((n, g) => n + g.length, 0) +
              Array.from(incoming.values()).reduce((n, g) => n + g.length, 0)
            })`}
          >
            <RelationshipSection
              outgoing={outgoing}
              incoming={incoming}
              loadedEntityIds={loadedEntityIds}
              onNavigate={onNavigate}
            />
          </Section>
        )}

        {/* Load more */}
        {entity.hasMore && (
          <div className="px-7 py-4 border-b border-zinc-800/60">
            <button
              onClick={onLoadMore}
              className="w-full px-4 py-2.5 text-[13px] text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-600 rounded-lg transition-colors cursor-pointer"
            >
              Load more connections...
            </button>
          </div>
        )}

        {/* Keywords */}
        {keywords.length > 0 && (
          <Section title="Keywords" defaultOpen={false}>
            <div className="flex flex-wrap gap-2">
              {keywords.map((k) => (
                <span
                  key={k}
                  className="text-[12px] text-zinc-400 bg-zinc-800/80 px-2.5 py-1 rounded"
                >
                  {k}
                </span>
              ))}
            </div>
          </Section>
        )}

        {/* Metadata footer */}
        <div className="px-7 py-5 mt-auto">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-[11px]">
            <div>
              <span className="text-zinc-600 uppercase tracking-wide">Created</span>
              <p className="text-zinc-500 mt-0.5">{relativeTime(entity.entity.created_at)}</p>
            </div>
            <div>
              <span className="text-zinc-600 uppercase tracking-wide">Version</span>
              <p className="text-zinc-500 mt-0.5">{entity.entity.ver}</p>
            </div>
            <div className="col-span-2">
              <span className="text-zinc-600 uppercase tracking-wide">ID</span>
              <p className="text-zinc-600 font-mono mt-0.5 break-all text-[10px]">
                {entity.entity.id}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
