// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState, useCallback, useEffect } from 'react'
import { createArkeClient } from '@/lib/arke-client'
import { MapView } from '@/components/MapView'

function getInitialParams() {
  const params = new URLSearchParams(window.location.search)
  return {
    select: params.get('select') || undefined,
  }
}

export function App() {
  const initial = useMemo(getInitialParams, [])
  const [selectId, setSelectId] = useState<string | undefined>(initial.select)

  const client = useMemo(() => createArkeClient(), [])

  useEffect(() => {
    const handler = () => {
      const params = new URLSearchParams(window.location.search)
      setSelectId(params.get('select') || undefined)
    }
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  const updateUrl = useCallback((updates: Record<string, string | null>) => {
    const url = new URL(window.location.href)
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) url.searchParams.delete(k)
      else url.searchParams.set(k, v)
    }
    window.history.pushState({}, '', url.toString())
  }, [])

  const handleEntitySelect = useCallback((entityId: string) => {
    setSelectId(entityId)
    updateUrl({ select: entityId })
  }, [updateUrl])

  const handleEntityDeselect = useCallback(() => {
    setSelectId(undefined)
    updateUrl({ select: null })
  }, [updateUrl])

  return (
    <div className="h-screen bg-[#0a0a0a] relative">
      <div className="absolute top-0 left-0 right-0 z-50 flex items-center gap-1 px-3 py-2 bg-[#0a0a0a]/80 backdrop-blur-sm border-b border-zinc-800/50">
        <span className="text-xs font-semibold text-zinc-600 select-none">Arkeon</span>
      </div>
      <div className="h-full">
        <MapView
          client={client}
          selectId={selectId}
          onEntitySelect={handleEntitySelect}
          onEntityDeselect={handleEntityDeselect}
        />
      </div>
    </div>
  )
}
