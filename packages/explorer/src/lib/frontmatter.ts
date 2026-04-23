// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser-side frontmatter parser. Strips JSON frontmatter from wiki
 * content so the EntityPanel can render just the body.
 */

export function parseFrontmatter(content: string): { properties: Record<string, unknown>; body: string } {
  const trimmed = content.trimStart()

  if (!trimmed.startsWith('---')) {
    return { properties: {}, body: content }
  }

  const firstNewline = trimmed.indexOf('\n')
  if (firstNewline === -1) return { properties: {}, body: content }

  const rest = trimmed.slice(firstNewline + 1)
  const closingIndex = rest.indexOf('\n---')
  if (closingIndex === -1) return { properties: {}, body: content }

  const jsonStr = rest.slice(0, closingIndex).trim()
  const body = rest.slice(closingIndex + 4).replace(/^\n/, '')

  let properties: Record<string, unknown>
  try {
    properties = JSON.parse(jsonStr)
  } catch {
    return { properties: {}, body: content }
  }

  return { properties, body }
}
