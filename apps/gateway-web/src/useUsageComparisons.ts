import { useEffect, useMemo, useState } from 'react'
import { usageComparisonRanges, type UsageTotals } from './usageStatistics'
type Key = 'previous' | 'year' | 'month'
export function useUsageComparisons(filters: string, enabled: boolean) {
 const ranges = useMemo(() => { const params = new URLSearchParams(filters); return usageComparisonRanges(params.get('from_time') ?? '', params.get('to_time') ?? '') }, [filters])
 const [values, setValues] = useState<Partial<Record<Key, UsageTotals | null>>>({})
 const [loading, setLoading] = useState(enabled)
 const [failed, setFailed] = useState(false)
 const [revision, setRevision] = useState(0)
 useEffect(() => {
  if (!enabled) return
  const controller = new AbortController()
  setLoading(true); setFailed(false); setValues({})
  const entries = (Object.entries(ranges) as Array<[Key, typeof ranges.month | null]>).filter(([,range]) => range)
  void Promise.allSettled(entries.map(async ([key, range]) => {
   const params = new URLSearchParams(filters)
   params.set('from_time', range!.from); params.set('to_time', range!.to)
   const response = await fetch(`/api/admin/usage?${params}`, { credentials: 'same-origin', signal: controller.signal })
   if (!response.ok) throw Error('对比用量加载失败')
   return [key, await response.json()] as const
  })).then(results => {
   if (controller.signal.aborted) return
   setValues(Object.fromEntries(results.filter(result => result.status === 'fulfilled').map(result => result.value)))
   setFailed(results.some(result => result.status === 'rejected')); setLoading(false)
  })
  return () => controller.abort()
 }, [filters, enabled, ranges, revision])
 return { ranges, values, loading, failed, retry: () => setRevision(value => value + 1) }
}
