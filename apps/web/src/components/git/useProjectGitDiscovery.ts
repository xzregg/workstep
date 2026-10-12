import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitApi, GitDiscovery } from '../../api/git'

/** A project ticket cannot use host-wide scan jobs or shared discovery state. */
export function useProjectGitDiscovery(api: GitApi, enabled: boolean) {
  const [data, setData] = useState<GitDiscovery | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<{ api: GitApi; promise: Promise<void> } | null>(null)
  const currentApi = useRef<GitApi | null>(api)
  currentApi.current = api
  const scan = useCallback(async (_key?: string) => {
    if (!enabled) return
    if (pending.current?.api === api) return pending.current.promise
    setScanning(true); setError('')
    const promise = api.repositories().then(result => {
      if (currentApi.current === api) setData(result)
    }).catch(reason => {
      if (currentApi.current === api) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (pending.current?.promise === promise) pending.current = null
      if (currentApi.current === api) setScanning(false)
    })
    pending.current = { api, promise }
    return promise
  }, [api, enabled])
  useEffect(() => {
    currentApi.current = api
    setData(null)
    void scan()
    return () => { if (currentApi.current === api) currentApi.current = null }
  }, [api, scan])
  return { data, scanning, error, scan, job: null }
}
