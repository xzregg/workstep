import { useMemo, useRef } from 'react'
import { collectOutputRate, rateFromSample } from '../utils/outputRate'
import type { DateTimeValue } from '../utils/datetime'

/** Freeze the last measured rate across tool waits, event trimming and rerenders. */
export function useOutputRate(
  events: unknown[] | undefined,
  startedAt?: DateTimeValue,
  summary?: Record<string, unknown> | null,
  running = false,
): number | null {
  const measured = useMemo(() => rateFromSample(collectOutputRate(events ?? []).sample), [events])
  const saved = rateFromSample(summary?.output_rate_sample)
  const retained = useRef<{ startedAt: DateTimeValue; rate: number | null }>({ startedAt, rate: null })
  if (retained.current.startedAt !== startedAt) retained.current = { startedAt, rate: null }
  const rate = running ? measured ?? retained.current.rate ?? saved : saved ?? measured ?? retained.current.rate
  if (rate !== null) retained.current.rate = rate
  return rate
}
