// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useState, useRef, useCallback } from 'react'
import type { LoadedEntity, OutgoingRel, IncomingRel } from '@/lib/arke-types'
import { parseProps } from '@/lib/arke-types'
import { getTypeColor } from '@/lib/type-colors'
import { parseFrontmatter } from '@/lib/frontmatter'

interface EntityPanelProps {
  entity: LoadedEntity
  loadedEntityIds: Set<string>
  onNavigate: (entityId: string) => void
  onClose: () => void
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
// Wiki content renderer — renders markdown with clickable links
// ---------------------------------------------------------------------------

function WikiContent({
  content,
  outgoing,
  onNavigate,
}: {
  content: string
  outgoing: OutgoingRel[]
  onNavigate: (id: string) => void
}) {
  // Build a map of link_path -> target_id for resolving clicks
  const linkTargetMap = new Map<string, { id: string; label: string }>()
  for (const rel of outgoing) {
    if (rel.link_path) {
      linkTargetMap.set(rel.link_path, { id: rel.target_id, label: rel.target_label })
    }
  }

  const containerRef = useRef<HTMLDivElement>(null)

  const scrollToSection = useCallback((slug: string) => {
    const el = containerRef.current?.querySelector(`[data-section="${slug}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  // Parse markdown links: [text](path.md)
  function inlineRender(text: string, keyPrefix: string): React.ReactNode[] {
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
    const boldRegex = /\*\*(.+?)\*\*/g
    const nodes: React.ReactNode[] = []
    let last = 0
    let idx = 0

    // Combined regex for links and bold
    const combinedRegex = /\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*/g
    let m: RegExpExecArray | null

    while ((m = combinedRegex.exec(text)) !== null) {
      if (m.index > last) nodes.push(text.slice(last, m.index))

      if (m[1] && m[2]) {
        // Markdown link [text](path)
        const linkText = m[1]
        const linkPath = m[2]
        const target = linkTargetMap.get(linkPath)

        if (target) {
          nodes.push(
            <button
              key={`${keyPrefix}-l${idx++}`}
              onClick={() => onNavigate(target.id)}
              className="text-blue-400 hover:text-blue-300 underline underline-offset-2 decoration-blue-400/40 hover:decoration-blue-300/60 transition-colors inline cursor-pointer"
            >
              {linkText}
            </button>,
          )
        } else if (linkPath.startsWith('http')) {
          nodes.push(
            <a
              key={`${keyPrefix}-a${idx++}`}
              href={linkPath}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 underline underline-offset-2"
            >
              {linkText}
            </a>,
          )
        } else {
          // Unresolved local link — render as plain text
          nodes.push(
            <span key={`${keyPrefix}-u${idx++}`} className="text-zinc-500">
              {linkText}
            </span>,
          )
        }
      } else if (m[3]) {
        // Bold
        nodes.push(
          <strong key={`${keyPrefix}-b${idx++}`} className="text-zinc-200 font-semibold">
            {m[3]}
          </strong>,
        )
      }
      last = m.index + m[0].length
    }
    if (last < text.length) nodes.push(text.slice(last))
    return nodes
  }

  // Strip frontmatter from content for display
  const { body } = parseFrontmatter(content)
  const lines = body.split('\n')
  const headings: Array<{ title: string; slug: string }> = []
  const blocks: React.ReactElement[] = []
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
      <div className="text-[15px] text-zinc-300 leading-[1.8]">
        {blocks}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Reference list (outgoing/incoming relationships)
// ---------------------------------------------------------------------------

function ReferenceList({
  items,
  onNavigate,
}: {
  items: Array<{ id: string; label: string; type: string }>
  onNavigate: (id: string) => void
}) {
  return (
    <div className="space-y-1">
      {items.map((item) => {
        const color = getTypeColor(item.type)
        return (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className="w-full flex items-center gap-2.5 px-2 py-2 rounded text-left hover:bg-zinc-800/60 transition-colors cursor-pointer"
          >
            <span
              className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded shrink-0"
              style={{ backgroundColor: color + '18', color }}
            >
              {item.type}
            </span>
            <span className="text-[14px] text-zinc-300 truncate">{item.label}</span>
          </button>
        )
      })}
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
          width="10" height="10" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.5" className="text-zinc-600"
          style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}
        >
          <path d="M3 1l4 4-4 4" />
        </svg>
      </button>
      {open && <div className="px-7 pb-5">{children}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function EntityPanel({
  entity,
  loadedEntityIds,
  onNavigate,
  onClose,
}: EntityPanelProps) {
  const props = parseProps(entity.entity)
  const color = getTypeColor(entity.entity.type)
  const isWiki = entity.entity.type === 'wiki'

  const label = entity.label || entity.entity.id.slice(0, 16)
  const shortDesc = (props.short_description as string) || entity.description || ''
  const aliases = (props.aliases as string[]) || []
  const keywords = (props.keywords as string[]) || []
  const subjectType = (props.subject_type as string) || ''

  const outgoingRefs = entity.outgoing.map((r) => ({
    id: r.target_id,
    label: r.target_label,
    type: r.target_type,
  }))

  const incomingRefs = entity.incoming.map((r) => ({
    id: r.source_id,
    label: r.source_label,
    type: r.source_type,
  }))

  return (
    <div
      className="absolute right-0 top-0 h-full bg-zinc-900 border-l border-zinc-800 overflow-y-auto z-50 flex flex-col"
      style={{ width: '45%', minWidth: '480px', maxWidth: '720px' }}
    >
      {/* Header */}
      <div className="sticky top-0 bg-zinc-900/95 backdrop-blur-sm border-b border-zinc-800 z-10">
        <div className="px-7 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
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
              </div>

              <h2 className="text-xl font-bold text-white leading-snug">{label}</h2>

              {shortDesc && (
                <p className="text-[15px] text-zinc-400 mt-2 leading-relaxed">{shortDesc}</p>
              )}

              {aliases.length > 0 && (
                <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                  {aliases.map((a) => (
                    <span key={a} className="text-[12px] text-zinc-500 bg-zinc-800/80 px-2 py-0.5 rounded">
                      {a}
                    </span>
                  ))}
                </div>
              )}
            </div>

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

      {/* Body */}
      <div className="flex-1">
        {/* Wiki article content */}
        {isWiki && entity.content && (
          <Section title="Article">
            <WikiContent
              content={entity.content}
              outgoing={entity.outgoing}
              onNavigate={onNavigate}
            />
          </Section>
        )}

        {/* References (outgoing links) */}
        {outgoingRefs.length > 0 && (
          <Section title={`References (${outgoingRefs.length})`} defaultOpen={!isWiki || !entity.content}>
            <ReferenceList items={outgoingRefs} onNavigate={onNavigate} />
          </Section>
        )}

        {/* Referenced by (incoming links) */}
        {incomingRefs.length > 0 && (
          <Section title={`Referenced by (${incomingRefs.length})`} defaultOpen={false}>
            <ReferenceList items={incomingRefs} onNavigate={onNavigate} />
          </Section>
        )}

        {/* Keywords */}
        {keywords.length > 0 && (
          <Section title="Keywords" defaultOpen={false}>
            <div className="flex flex-wrap gap-2">
              {keywords.map((k) => (
                <span key={k} className="text-[12px] text-zinc-400 bg-zinc-800/80 px-2.5 py-1 rounded">
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
              <span className="text-zinc-600 uppercase tracking-wide">Path</span>
              <p className="text-zinc-500 mt-0.5 font-mono text-[10px]">{entity.entity.source_path}</p>
            </div>
            <div className="col-span-2">
              <span className="text-zinc-600 uppercase tracking-wide">ID</span>
              <p className="text-zinc-600 font-mono mt-0.5 break-all text-[10px]">{entity.entity.id}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
