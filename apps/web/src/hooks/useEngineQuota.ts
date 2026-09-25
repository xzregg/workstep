import { useCallback, useEffect, useRef, useState } from 'react'
import { engineApi, type EngineQuota } from '../api/client'

/** Owns the quota request for the selected project and engine. */
export function useEngineQuota(projectId: string | undefined, engine: string, running: boolean) {
  const [snapshot, setSnapshot] = useState<{
    projectId: string
    engine: string
    quota: EngineQuota | null
  } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const requestIdRef = useRef(0)

  const refresh = useCallback(async () => {
    if (!projectId) return
    const requestId = ++requestIdRef.current
    setRefreshing(true)
    try {
      const result = await engineApi.quota(engine, projectId)
      if (requestIdRef.current === requestId) {
        setSnapshot({ projectId, engine, quota: result.quota })
      }
    } catch {
      if (requestIdRef.current === requestId) {
        setSnapshot({ projectId, engine, quota: null })
      }
    } finally {
      if (requestIdRef.current === requestId) setRefreshing(false)
    }
  }, [engine, projectId])

  useEffect(() => {
    if (running || !projectId) {
      requestIdRef.current += 1
      setRefreshing(false)
      return
    }
    void refresh()
    return () => { requestIdRef.current += 1 }
  }, [running, projectId, refresh])

  const quota = snapshot && snapshot.projectId === projectId && snapshot.engine === engine
    ? snapshot.quota
    : null
  return { quota, refreshing, refresh }
}
