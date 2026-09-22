export type PlanPriority = 'high' | 'medium' | 'low'
export type PlanStatus = 'pending' | 'in_progress' | 'completed'

export interface PlanEntry {
  content: string
  detail?: string
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
  name?: string
  value?: Record<string, unknown>
  toolCallId?: string
  tool_call_id?: string
  args?: unknown
  delta?: string
}

function stepDetailsFromEvents(events: PlanStreamEvent[]): Map<string, string> {
  const argsByCallId = new Map<string, string>()
  const details = new Map<string, string>()
  const contentKey = (content: string) => content.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
  const collectRecord = (input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return
    const record = input as Record<string, unknown>
    const subject = String(record.subject || record.content || '').trim()
    const detail = String(record.detail || record.details || record.description || '').trim()
    if (subject && detail && subject !== detail) details.set(contentKey(subject), detail)
  }
  const collect = (value: unknown) => {
    if (typeof value !== 'string') {
      collectRecord(value)
      return
    }
    try {
      collectRecord(JSON.parse(value))
      return
    } catch {
      // Some engines reuse tool call IDs, producing adjacent JSON objects.
    }
    let start = -1
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') {
        inString = true
        continue
      }
      if (character === '{') {
        if (depth === 0) start = index
        depth += 1
      } else if (character === '}' && depth > 0) {
        depth -= 1
        if (depth === 0 && start >= 0) {
          try {
            collectRecord(JSON.parse(value.slice(start, index + 1)))
          } catch {
            // Ignore malformed partial arguments; later snapshots may complete them.
          }
          start = -1
        }
      }
    }
  }

  for (const event of events) {
    const callId = String(
      event.toolCallId || event.tool_call_id
      || event.data?.tool_call_id || event.data?.toolCallId || '',
    ).trim()
    if (event.type === 'TOOL_CALL_ARGS') collect(event.args)
    if (event.type === 'TOOL_CALL_CHUNK' && callId) {
      argsByCallId.set(callId, (argsByCallId.get(callId) || '') + String(event.delta || ''))
    }
    if (event.type === 'tool_call' && event.data?.raw_input !== undefined) {
      collect(event.data.raw_input)
    }
    if (event.type === 'tool_call_update' && callId && event.data?.raw_input !== undefined) {
      argsByCallId.set(
        callId,
        (argsByCallId.get(callId) || '') + String(event.data.raw_input || ''),
      )
    }
  }
  for (const args of argsByCallId.values()) collect(args)
  return details
}

export function mergePlanEvents(
  persisted: PlanStreamEvent[] = [],
  live: PlanStreamEvent[] = [],
): PlanStreamEvent[] {
  if (live.some((event) => event.type === 'plan' || isCustom(event, CUSTOM.plan))) {
    return live
  }
  const latestPersistedPlan = [...persisted].reverse().find(
    (event) => event.type === 'plan' || isCustom(event, CUSTOM.plan),
  )
  return latestPersistedPlan ? [latestPersistedPlan, ...live] : live
}

export function latestPlanFromEvents(
  events: PlanStreamEvent[],
): PlanSnapshot | undefined {
  const event = [...events].reverse().find(
    (candidate) => candidate.type === 'plan' || isCustom(candidate, CUSTOM.plan),
  )
  if (!event) return undefined
  const data = isCustom(event, CUSTOM.plan) ? customValue(event) : event.data
  const rawEntries = data?.entries
  if (!Array.isArray(rawEntries)) return undefined
  const streamedDetails = stepDetailsFromEvents(events)
  const contentKey = (content: string) => content.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
  const candidates = rawEntries.flatMap((entry) => {
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
    const directDetail = String(value.detail || value.details || value.description || '').trim()
    const detail = directDetail || streamedDetails.get(contentKey(content))
    const taskId = String(value.taskId || value.task_id || value.id || '').trim()
    return [{
      entry: {
        content,
        ...(detail && detail !== content ? { detail } : {}),
        priority,
        status,
      },
      taskId,
    }]
  })
  const entries: PlanEntry[] = []
  const entryTaskIds: string[] = []
  const indexesByTaskId = new Map<string, number>()
  const indexesByContent = new Map<string, number>()
  const taskOrdinal = (content: string): number | undefined => {
    const match = content.trim().match(/^(?:#|task[\s_-]*)?(\d+)$/i)
    if (!match) return undefined
    const ordinal = Number(match[1])
    return Number.isSafeInteger(ordinal) && ordinal > 0 ? ordinal : undefined
  }

  for (const candidate of candidates) {
    const key = contentKey(candidate.entry.content)
    const ordinal = candidate.taskId ? undefined : taskOrdinal(candidate.entry.content)
    const ordinalIndex = ordinal === undefined ? undefined : ordinal - 1
    if (
      ordinalIndex !== undefined
      && ordinalIndex < entries.length
      && taskOrdinal(entries[ordinalIndex].content) === undefined
    ) {
      entries[ordinalIndex] = {
        ...entries[ordinalIndex],
        ...candidate.entry,
        content: entries[ordinalIndex].content,
        detail: candidate.entry.detail || entries[ordinalIndex].detail,
      }
      indexesByContent.set(key, ordinalIndex)
      continue
    }
    let index = candidate.taskId
      ? indexesByTaskId.get(candidate.taskId)
      : indexesByContent.get(key)
    if (index === undefined && candidate.taskId) {
      const contentIndex = indexesByContent.get(key)
      if (contentIndex !== undefined && !entryTaskIds[contentIndex]) {
        index = contentIndex
      }
    }
    if (index === undefined) {
      index = entries.length
      entries.push(candidate.entry)
      entryTaskIds.push(candidate.taskId)
    } else {
      const previousKey = contentKey(entries[index].content)
      if (previousKey !== key && indexesByContent.get(previousKey) === index) {
        indexesByContent.delete(previousKey)
      }
      entries[index] = {
        ...entries[index],
        ...candidate.entry,
        detail: candidate.entry.detail || entries[index].detail,
      }
      if (candidate.taskId) entryTaskIds[index] = candidate.taskId
    }
    if (candidate.taskId) indexesByTaskId.set(candidate.taskId, index)
    indexesByContent.set(key, index)
  }
  const explanation = String(data?.explanation || '').trim() || undefined
  return {
    ...(explanation ? { explanation } : {}),
    entries,
    completed: entries.filter((entry) => entry.status === 'completed').length,
    total: entries.length,
  }
}
import { CUSTOM, customValue, isCustom } from './agui.ts'
