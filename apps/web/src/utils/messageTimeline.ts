import {
  CUSTOM,
  customValue,
  isCustom,
  isCommentaryEvent,
  isReasoningEvent,
  toolArgs,
  toolCallId,
  toolName,
  toolOutput,
} from './agui.ts'
import { toMilliseconds, type DateTimeValue } from './datetime'

export type MessageTimelineEvent = {
  type?: string
  data?: Record<string, unknown>
  delta?: string
  content?: string
  phase?: string
  source_item_id?: string
  isError?: boolean
  timestamp?: unknown
  created_at?: string
}

export type ToolActivity = {
  id: string
  name: string
  input?: unknown
  result?: unknown
  hasResult: boolean
  isError: boolean
}

export type SubagentActivity = {
  taskId: string
  description: string
  status: string
  summary?: string
  lastToolName?: string
  events?: MessageTimelineEvent[]
}

export type MessageTimelineItem =
  | { type: 'text'; id: string; content: string }
  | { type: 'commentary'; id: string; content: string; sourceItemId?: string }
  | { type: 'thinking'; id: string; content: string; startedAt?: number; endedAt?: number }
  | { type: 'tool'; id: string; activity: ToolActivity }
  | { type: 'tool-group'; id: string; activities: ToolActivity[] }
  | { type: 'subagent'; id: string; activity: SubagentActivity }

function eventText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return String(value)
}

export function characterCount(content: string): number {
  return Array.from(content).length
}

/**
 * 估算 token 数：CJK 字符 ≈ 1 token/字符，ASCII/其他 ≈ 1 token/4 字符。
 * 适用于流式过程中的轻量实时估算，非精确 tokenizer。
 */
export function estimateTokens(content: string): number {
  if (!content) return 0
  let cjk = 0
  let other = 0
  for (const ch of content) {
    const code = ch.codePointAt(0)!
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||   // CJK Unified
      (code >= 0x3400 && code <= 0x4dbf) ||   // CJK Extension A
      (code >= 0x3040 && code <= 0x30ff) ||   // Japanese kana
      (code >= 0xac00 && code <= 0xd7af) ||   // Korean
      (code >= 0xf900 && code <= 0xfaff)      // CJK Compatibility
    ) {
      cjk++
    } else {
      other++
    }
  }
  return Math.max(1, Math.round(cjk + other / 4))
}

export function buildMessageTimeline(
  events: MessageTimelineEvent[],
): MessageTimelineItem[] {
  const timeline: MessageTimelineItem[] = []
  const toolsById = new Map<string, ToolActivity>()
  const subagentsById = new Map<string, SubagentActivity>()
  const appendTool = (activity: ToolActivity) => {
    const previous = timeline[timeline.length - 1]
    if (previous?.type === 'tool-group') {
      previous.activities.push(activity)
    } else if (previous?.type === 'tool') {
      timeline[timeline.length - 1] = {
        type: 'tool-group',
        id: `tool-group-${previous.activity.id}`,
        activities: [previous.activity, activity],
      }
    } else {
      timeline.push({ type: 'tool', id: `tool-${activity.id}`, activity })
    }
  }

  events.forEach((event, index) => {
    const data = event.data || {}
    const timestamp = toMilliseconds(
      (event.timestamp ?? event.created_at) as DateTimeValue,
    )
    const thinkingEvent = isReasoningEvent(event) || event.type === 'thinking_delta'
    const previous = timeline[timeline.length - 1]
    if (!thinkingEvent && timestamp !== null && previous?.type === 'thinking') {
      previous.endedAt = timestamp
    }
    if (isReasoningEvent(event)) {
      const delta = eventText(event.delta ?? data.delta ?? data.text)
      if (!delta) return
      if (previous?.type === 'thinking') {
        previous.content += delta
        if (timestamp !== null) {
          previous.startedAt ??= timestamp
          previous.endedAt = timestamp
        }
      } else {
        timeline.push({
          type: 'thinking',
          id: `thinking-${index}`,
          content: delta,
          ...(timestamp !== null ? { startedAt: timestamp, endedAt: timestamp } : {}),
        })
      }
      return
    }

    if (event.type === 'thinking_delta') {
      const delta = eventText(data.delta ?? data.text)
      if (!delta) return
      if (previous?.type === 'thinking') {
        previous.content += delta
        if (timestamp !== null) {
          previous.startedAt ??= timestamp
          previous.endedAt = timestamp
        }
      } else {
        timeline.push({
          type: 'thinking',
          id: `thinking-${index}`,
          content: delta,
          ...(timestamp !== null ? { startedAt: timestamp, endedAt: timestamp } : {}),
        })
      }
      return
    }

    if (isCommentaryEvent(event)) {
      const delta = eventText(event.content ?? event.delta)
      if (!delta) return
      if (previous?.type === 'commentary' && previous.sourceItemId === event.source_item_id) {
        previous.content = event.type === 'TEXT_MESSAGE_CONTENT' ? delta : previous.content + delta
      } else {
        timeline.push({
          type: 'commentary', id: `commentary-${index}`, content: delta,
          sourceItemId: event.source_item_id,
        })
      }
      return
    }

    if (event.type === 'TEXT_MESSAGE_CHUNK') {
      const delta = eventText(event.delta ?? data.delta ?? data.text)
      if (!delta) return
      const previous = timeline[timeline.length - 1]
      if (previous?.type === 'text') {
        previous.content += delta
      } else {
        timeline.push({ type: 'text', id: `text-${index}`, content: delta })
      }
      return
    }

    if (event.type === 'text_delta') {
      const delta = eventText(data.delta ?? data.text)
      if (!delta) return
      const previous = timeline[timeline.length - 1]
      if (previous?.type === 'text') {
        previous.content += delta
      } else {
        timeline.push({ type: 'text', id: `text-${index}`, content: delta })
      }
      return
    }

    if (event.type === 'TOOL_CALL_START') {
      const id = toolCallId(event)
      const existing = toolsById.get(id)
      if (existing) {
        existing.name = toolName(event) || existing.name
        return
      }
      const activity: ToolActivity = {
        id,
        name: toolName(event),
        hasResult: false,
        isError: false,
      }
      toolsById.set(id, activity)
      appendTool(activity)
      return
    }

    if (event.type === 'tool_use') {
      const id = String(data.id || data.tool_use_id || `tool-${index}`)
      const existing = toolsById.get(id)
      if (existing) {
        existing.name = String(data.name || existing.name)
        existing.input = data.input ?? existing.input
        return
      }
      const activity: ToolActivity = {
        id,
        name: String(data.name || 'tool'),
        input: data.input,
        hasResult: false,
        isError: false,
      }
      toolsById.set(id, activity)
      appendTool(activity)
      return
    }

    if (event.type === 'TOOL_CALL_ARGS' || event.type === 'tool_input_delta') {
      if (event.type === 'TOOL_CALL_ARGS') {
        const id = toolCallId(event)
        const activity = toolsById.get(id)
        if (!activity) return
        activity.input = toolArgs(event)
        return
      }
      const id = String(data.tool_use_id || data.id || '')
      const activity = toolsById.get(id)
      if (!activity) return
      const delta = eventText(data.delta ?? data.input)
      if (!delta) return
      activity.input = typeof activity.input === 'string'
        ? activity.input + delta
        : delta
      return
    }

    if (event.type === 'TOOL_CALL_CHUNK') {
      const id = toolCallId(event)
      const activity = toolsById.get(id)
      if (!activity) return
      const delta = eventText(toolArgs(event) ?? '')
      if (!delta) return
      activity.input = typeof activity.input === 'string'
        ? activity.input + delta
        : delta
      return
    }

    if (event.type === 'TOOL_CALL_RESULT' || event.type === 'tool_result') {
      if (event.type === 'TOOL_CALL_RESULT') {
        const id = toolCallId(event)
        let activity = toolsById.get(id)
        if (!activity) {
          activity = {
            id,
            name: toolName(event),
            hasResult: true,
            isError: Boolean(event.isError),
          }
          toolsById.set(id, activity)
          appendTool(activity)
        }
        activity.result = toolOutput(event)
        activity.hasResult = true
        activity.isError = Boolean(event.isError)
        return
      }
      const id = String(data.tool_use_id || data.id || `result-${index}`)
      let activity = toolsById.get(id)
      if (!activity) {
        activity = {
          id,
          name: String(data.name || 'tool'),
          hasResult: true,
          isError: Boolean(data.is_error),
        }
        toolsById.set(id, activity)
        appendTool(activity)
      }
      activity.result = data.content ?? data.result
      activity.hasResult = true
      activity.isError = Boolean(data.is_error)
    }

    if (isCustom(event, CUSTOM.subagent)) {
      const value = customValue(event)
      const taskId = String(value.task_id || value.id || `subagent-${index}`)
      const childEvents = Array.isArray(value.events) ? value.events.filter((event): event is MessageTimelineEvent => Boolean(event && typeof event === 'object')) : []
      const toolUseId = eventText(value.tool_use_id)
      const existing = subagentsById.get(taskId) || (toolUseId ? subagentsById.get(toolUseId) : undefined)
      const status = String(value.status || 'running')
      const description = eventText(value.description ?? value.subject ?? taskId)
      const lastToolName = eventText(value.last_tool_name ?? '')
      if (existing) {
        subagentsById.set(taskId, existing)
        if (toolUseId) subagentsById.set(toolUseId, existing)
        existing.status = status
        if (childEvents.length) existing.events = [...(existing.events ?? []), ...childEvents]
        if (description && description !== taskId) existing.description = description
        const summary = eventText(value.summary ?? '')
        if (summary) existing.summary = summary
        if (lastToolName) existing.lastToolName = lastToolName
        return
      }
      const activity: SubagentActivity = {
        taskId,
        description,
        status,
        events: childEvents,
        ...(eventText(value.summary ?? '') ? { summary: eventText(value.summary) } : {}),
        ...(lastToolName ? { lastToolName } : {}),
      }
      subagentsById.set(taskId, activity)
      if (toolUseId) subagentsById.set(toolUseId, activity)
      timeline.push({ type: 'subagent', id: `subagent-${taskId}`, activity })
      return
    }

    if (event.type === 'subagent') {
      const taskId = String(data.task_id || data.id || `subagent-${index}`)
      const existing = subagentsById.get(taskId)
      const status = String(data.status || 'running')
      const description = eventText(data.description ?? data.subject ?? taskId)
      const lastToolName = eventText(data.last_tool_name ?? '')
      if (existing) {
        existing.status = status
        if (description && description !== taskId) existing.description = description
        const summary = eventText(data.summary ?? '')
        if (summary) existing.summary = summary
        if (lastToolName) existing.lastToolName = lastToolName
        return
      }
      const activity: SubagentActivity = {
        taskId,
        description,
        status,
        ...(eventText(data.summary ?? '') ? { summary: eventText(data.summary) } : {}),
        ...(lastToolName ? { lastToolName } : {}),
      }
      subagentsById.set(taskId, activity)
      timeline.push({ type: 'subagent', id: `subagent-${taskId}`, activity })
      return
    }
  })

  return timeline
}

export function timelineText(timeline: MessageTimelineItem[]): string {
  return timeline
    .filter((item): item is Extract<MessageTimelineItem, { type: 'text' }> => item.type === 'text')
    .map((item) => item.content)
    .join('')
}
