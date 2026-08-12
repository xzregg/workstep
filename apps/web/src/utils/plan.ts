export type PlanPriority = 'high' | 'medium' | 'low'
export type PlanStatus = 'pending' | 'in_progress' | 'completed'

export interface PlanEntry {
  content: string
  priority: PlanPriority
  status: PlanStatus
}

export interface PlanSnapshot {
  explanation?: string
  entries: PlanEntry[]
  completed: number
  total: number
}

export interface PlanStreamEvent {
  type?: string
  data?: Record<string, unknown>
}

export function mergePlanEvents(
  persisted: PlanStreamEvent[] = [],
  live: PlanStreamEvent[] = [],
): PlanStreamEvent[] {
  if (live.some((event) => event.type === 'plan')) return live
  const latestPersistedPlan = [...persisted].reverse().find(
    (event) => event.type === 'plan',
  )
  return latestPersistedPlan ? [latestPersistedPlan, ...live] : live
}

export function latestPlanFromEvents(
  events: PlanStreamEvent[],
): PlanSnapshot | undefined {
  const event = [...events].reverse().find((candidate) => candidate.type === 'plan')
  if (!event) return undefined
  const rawEntries = event.data?.entries
  if (!Array.isArray(rawEntries)) return undefined
  const entries = rawEntries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const value = entry as Record<string, unknown>
    const content = String(value.content || '').trim()
    if (!content) return []
    const priority = ['high', 'medium', 'low'].includes(String(value.priority))
      ? value.priority as PlanPriority
      : 'medium'
    const status = ['pending', 'in_progress', 'completed'].includes(String(value.status))
      ? value.status as PlanStatus
      : 'pending'
    return [{ content, priority, status }]
  })
  const explanation = String(event.data?.explanation || '').trim() || undefined
  return {
    ...(explanation ? { explanation } : {}),
    entries,
    completed: entries.filter((entry) => entry.status === 'completed').length,
    total: entries.length,
  }
}
