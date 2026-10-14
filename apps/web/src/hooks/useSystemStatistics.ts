import { useCallback, useEffect, useRef, useState } from 'react'
import { statisticsApi } from '../api/statistics'
import type { SystemStatisticsReport } from '../api/systemStatistics'

/** One visible panel, one request at a time; late results never update unmounted UI. */
export function useSystemStatistics() {
  const [report, setReport] = useState<SystemStatisticsReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [paused, setPaused] = useState(false)
  const alive = useRef(false)
  const generation = useRef(0)
  const inFlight = useRef<Promise<void> | null>(null)
  const refresh = useCallback(() => {
    if (inFlight.current) return inFlight.current
    if (!alive.current || document.visibilityState === 'hidden') return Promise.resolve()
    const current = generation.current
    setLoading(true)
    const promise = statisticsApi.system().then(value => {
      if (alive.current && generation.current === current) { setReport(value); setFailed(false) }
    }).catch(() => {
      if (alive.current && generation.current === current) setFailed(true)
    }).finally(() => {
      if (inFlight.current === promise) inFlight.current = null
      if (alive.current && generation.current === current) setLoading(false)
    })
    inFlight.current = promise
    return promise
  }, [])
  useEffect(() => {
    alive.current = true
    const current = ++generation.current
    inFlight.current = null
    void refresh()
    return () => { alive.current = false; generation.current = current + 1; inFlight.current = null }
  }, [refresh])
  useEffect(() => {
    if (paused) return
    let timer: number | undefined
    let stopped = false
    const schedule = () => {
      if (stopped || document.visibilityState === 'hidden') return
      timer = window.setTimeout(async () => { await refresh(); schedule() }, (report?.interval_seconds || 5) * 1000)
    }
    const visibility = () => {
      window.clearTimeout(timer)
      if (document.visibilityState !== 'hidden') { void refresh(); schedule() }
    }
    schedule()
    document.addEventListener('visibilitychange', visibility)
    return () => { stopped = true; window.clearTimeout(timer); document.removeEventListener('visibilitychange', visibility) }
  }, [paused, refresh, report?.interval_seconds])
  return { report, loading, failed, paused, refresh, togglePaused: () => setPaused(value => !value) }
}
