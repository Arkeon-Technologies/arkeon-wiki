// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Entity, Relationship, OutgoingRel, IncomingRel, Space } from './arke-types'

export interface ArkeClient {
  /** Fetch all entities + relationships for a space (or all spaces). */
  fetchEntities(spaceId?: string): Promise<{
    entities: Entity[]
    relationships: Relationship[]
    total: number
  }>
  /** Fetch a single entity with relationships and file content. */
  fetchEntity(id: string): Promise<
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
    async fetchEntities(spaceId?: string) {
      const params = new URLSearchParams({
        include: 'relationships',
        limit: '10000',
      })
      if (spaceId) params.set('space_id', spaceId)
      return apiFetch(`/entities?${params.toString()}`)
    },

    async fetchEntity(id: string) {
      return apiFetch(`/entities/${id}?include=content`)
    },

    async fetchSpaces() {
      const data = await apiFetch<{ spaces: Space[] }>('/spaces')
      return data.spaces
    },
  }
}
