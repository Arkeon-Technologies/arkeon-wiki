// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser-side frontmatter parser. Strips YAML frontmatter from wiki
 * content so the EntityPanel can render just the body.
 */

import yaml from 'js-yaml'

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

  const yamlStr = rest.slice(0, closingIndex)
  const body = rest.slice(closingIndex + 4).replace(/^\n/, '')

  let parsed: unknown
  try {
    parsed = yaml.load(yamlStr, { schema: yaml.JSON_SCHEMA })
  } catch {
    return { properties: {}, body: content }
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { properties: parsed as Record<string, unknown>, body }
  }
  return { properties: {}, body }
}
