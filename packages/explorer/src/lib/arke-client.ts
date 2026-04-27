// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Entity, Relationship, OutgoingRel, IncomingRel, Space } from './arke-types'

export interface ArkeClient {
  /** Fetch all wikis + relationships for a space (or all spaces). */
  fetchWikis(spaceId?: string): Promise<{
    wikis: Entity[]
    relationships: Relationship[]
    total: number
  }>
  /** Fetch a single wiki with relationships and file content. */
  fetchWiki(id: string): Promise<
    Entity & {
      relationships: { outgoing: OutgoingRel[]; incoming: IncomingRel[] }
    }
  >
  /** Fetch all spaces. */
  fetchSpaces(): Promise<Space[]>
}

export function createArkeClient(baseUrl = ''): ArkeClient {
  async function apiFetch<T>(path: string): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`)
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`API error ${res.status}: ${body}`)
    }
    return res.json() as Promise<T>
  }

  return {
    async fetchWikis(spaceId?: string) {
      const params = new URLSearchParams({
        include: 'relationships',
        limit: '10000',
      })
      if (spaceId) params.set('space_id', spaceId)
      return apiFetch(`/wikis?${params.toString()}`)
    },

    async fetchWiki(id: string) {
      return apiFetch(`/wikis/${id}?include=content`)
    },

    async fetchSpaces() {
      const data = await apiFetch<{ spaces: Space[] }>('/spaces')
      return data.spaces
    },
  }
}
