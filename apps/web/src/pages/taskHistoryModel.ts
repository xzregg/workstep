/** History pagination, event detail merging, and refresh preservation. */
function eventSequence(event: any): number | null {
  const value = event?.event_sequence ?? event?.sequence ?? event?.seq
  return typeof value === 'number' ? value : null
}

export function mergeLoadedTaskMessageEvents(
  messages: any[],
  messageId: string,
  loadedEvents: any[],
  detail: { complete: boolean; next_cursor: number | null },
): any[] {
  return messages.map((message) => {
    if (message.id !== messageId) return message
    const merged = [...loadedEvents, ...(message.events ?? [])]
    const seen = new Set<string>()
    const events = merged.filter((event) => {
      const sequence = eventSequence(event)
      const key = sequence === null
        ? JSON.stringify(event)
        : `sequence:${sequence}:${event.type ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).sort((left, right) => (
      (eventSequence(left) ?? Number.MAX_SAFE_INTEGER)
      - (eventSequence(right) ?? Number.MAX_SAFE_INTEGER)
    ))
    return {
      ...message,
      events,
      event_detail: {
        ...message.event_detail,
        available: true,
        loaded: true,
        loading: false,
        complete: detail.complete,
        next_cursor: detail.next_cursor,
        error: '',
      },
    }
  })
}

export function mergeRefreshedTaskHistory(current: any[], refreshed: any[]): any[] {
  const currentById = new Map(current.map((message) => [message.id, message]))
  const merged = refreshed.map((message) => {
    const existing = currentById.get(message.id)
    if (!existing?.event_detail?.loaded
      || existing.step_run_id !== message.step_run_id
      || existing.event_log_path !== message.event_log_path) return message
    return {
      ...message,
      events: existing.events,
      event_detail: existing.event_detail,
    }
  })
  const refreshedIds = new Set(refreshed.map((message) => message.id))
  const refreshedSequences = refreshed
    .map((message) => message.sequence)
    .filter((sequence): sequence is number => typeof sequence === 'number')
  const oldestRefreshedSequence = refreshedSequences.length > 0
    ? Math.min(...refreshedSequences)
    : null
  return [
    ...current.filter((message) => {
      if (refreshedIds.has(message.id)) return false
      if (String(message.id).startsWith('pending-')) return true
      return oldestRefreshedSequence !== null
        && typeof message.sequence === 'number'
        && message.sequence >= oldestRefreshedSequence
    }),
    ...merged,
  ]
}

export async function loadTaskHistoryWithRetry<T>(
  load: () => Promise<T>,
  signal: AbortSignal,
  retryDelayMs = 1500,
): Promise<T | undefined> {
  let failures = 0
  while (!signal.aborted) {
    try {
      return await load()
    } catch {
      if (signal.aborted) break
      const delay = Math.min(retryDelayMs * 2 ** failures, 30_000)
      failures += 1
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }, delay)
        signal.addEventListener('abort', onAbort, { once: true })
      })
    }
  }
  return undefined
}

