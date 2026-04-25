// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

const NO_SPACE_COLOR = '#d4d4d8'

// Hand-picked palette of visually distinct colors for spaces.
// Maximum perceptual distance on a dark background.
const SPACE_PALETTE = [
  '#c084fc', // purple
  '#34d399', // emerald
  '#f97316', // orange
  '#38bdf8', // sky
  '#fb7185', // rose
  '#a3e635', // lime
  '#fbbf24', // amber
  '#22d3ee', // cyan
  '#e879f9', // fuchsia
  '#4ade80', // green
  '#f87171', // red
  '#60a5fa', // blue
  '#facc15', // yellow
  '#2dd4bf', // teal
  '#a78bfa', // violet
  '#fb923c', // light orange
]

// Assign colors by encounter order so each space gets a maximally distinct color.
const spaceColorMap = new Map<string, string>()
let nextColorIndex = 0

export function getSpaceColor(spaceId: string | undefined): string {
  if (!spaceId) return NO_SPACE_COLOR

  const existing = spaceColorMap.get(spaceId)
  if (existing) return existing

  const color = SPACE_PALETTE[nextColorIndex % SPACE_PALETTE.length]
  nextColorIndex++
  spaceColorMap.set(spaceId, color)
  return color
}

/**
 * Get the color for an entity based on its space_id.
 */
export function getEntitySpaceColor(spaceId?: string): string {
  return getSpaceColor(spaceId)
}
