import { useCallback, useEffect, useRef, useState } from 'react'
import { engineApi, type UnifiedQuotaResult } from '../api/client'

/** All engines share the daemon cache; engine selection is a local projection. */
export function useEngineQuota(projectId: string | undefined, engine: string, conversationKey = '', enabled = true) {
  const [snapshot, setSnapshot] = useState<{ projectId: string; result: UnifiedQuotaResult } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(false)
  const requestId = useRef(0)
  const scope = projectId || ''
  const refresh = useCallback(async (force = true) => {
    if (!enabled) return
    const id = ++requestId.current
    setRefreshing(true)
    setError(false)
    try {
      const result = await engineApi.quotas(scope, force)
      if (requestId.current === id) setSnapshot({projectId: scope, result})
    } catch {
      if (requestId.current === id) setError(true)
    } finally {
      if (requestId.current === id) setRefreshing(false)
    }
  }, [scope, enabled])
  useEffect(() => {
    void refresh(false)
    return () => { requestId.current += 1 }
  }, [refresh, conversationKey])
  const entries = snapshot?.projectId === scope && Array.isArray(snapshot.result?.engines)
    ? snapshot.result.engines.filter(entry => entry.supported)
    : []
  const selected = entries.find(entry => entry.engine_id === engine)
  return {entries, quota: selected?.status === 'ok' ? selected.quota : null, refreshing, refresh, error}
}
