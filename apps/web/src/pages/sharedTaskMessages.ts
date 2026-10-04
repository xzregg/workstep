/** The share stream contains both AG-UI events and older daemon event names. */
const MAX_LIVE_SHARED_EVENTS = 2000

type SharedMessage = Record<string, any> & { id: string }
type SharedEvent = Record<string, any>

function appendCappedSharedEvent(events: SharedEvent[] | undefined, event: SharedEvent): SharedEvent[] {
  const combined = [...(events ?? []), event]
  return combined.length > MAX_LIVE_SHARED_EVENTS
    ? combined.slice(-MAX_LIVE_SHARED_EVENTS) : combined
}

export function capSharedHistoryEvents(message: SharedMessage): SharedMessage {
  return Array.isArray(message.events) && message.events.length > MAX_LIVE_SHARED_EVENTS
    ? { ...message, events: message.events.slice(-MAX_LIVE_SHARED_EVENTS) }
    : message
}

/** Apply one live event without mutating an earlier message snapshot. */
export function applySharedMessageEvent(messages: SharedMessage[], event: SharedEvent): SharedMessage[] {
  const kind = event?.type
  const messageId = event?.messageId ?? event?.message_id
  const isText = kind === 'text_delta' || kind === 'TEXT_MESSAGE_CHUNK'
  const isReasoning = kind === 'thinking_delta' || kind === 'REASONING_MESSAGE_CHUNK'
  if (isText || isReasoning) {
    if (!messageId) return messages
    const index = messages.findIndex((message) => message.id === messageId)
    if (index < 0) {
      const createdAt = event.created_at ?? new Date().toISOString()
      return [...messages, {
        id: messageId, role: 'assistant',
        content: isText ? event.delta ?? event.text ?? '' : '',
        step_key: event.step_key, channel: 'execution', run_status: 'running',
        events: isReasoning ? [event] : [],
        started_at: createdAt, ended_at: null, created_at: createdAt,
      }]
    }
    const existing = messages[index]
    const updated = isText
      ? { ...existing, content: (existing.content ?? '') + (event.delta ?? event.text ?? '') }
      : { ...existing, events: appendCappedSharedEvent(existing.events, event) }
    const next = messages.slice()
    next[index] = updated
    return next
  }

  const isTool = ['tool_use', 'tool_input_delta', 'tool_result', 'TOOL_CALL_START',
    'TOOL_CALL_ARGS', 'TOOL_CALL_CHUNK', 'TOOL_CALL_RESULT'].includes(kind)
  const isInteraction = kind === 'interaction_request' || kind === 'interaction_response'
    || event?.name === 'workstep.interaction_request'
    || event?.name === 'workstep.interaction_response'
  const isStatus = ['status', 'done', 'RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR'].includes(kind)
  if ((!isTool && !isInteraction && !isStatus) || !messageId) return messages
  const index = messages.findIndex((message) => message.id === messageId)
  if (index < 0) return messages
  const existing = messages[index]
  const updated = isStatus
    ? { ...existing, run_status: event.status ?? existing.run_status,
      ended_at: event.created_at ?? existing.ended_at ?? new Date().toISOString() }
    : { ...existing, events: appendCappedSharedEvent(existing.events, event) }
  const next = messages.slice()
  next[index] = updated
  return next
}

/** Refresh the latest page while retaining earlier pages and expanded event details. */
export function mergeSharedHistorySnapshot(previous: SharedMessage[], snapshot: SharedMessage[]): SharedMessage[] {
  const incoming = new Map(snapshot.map(message => [message.id, capSharedHistoryEvents(message)]))
  const merged = previous.filter(message => !message.id.startsWith('gateway-interaction:') || incoming.has(message.id))
    .map(message => {
      const fresh = incoming.get(message.id)
      if (!fresh) return message
      incoming.delete(message.id)
      return message.event_detail?.loaded
        ? { ...fresh, events: message.events, event_detail: message.event_detail }
        : fresh
    })
  return [...merged, ...incoming.values()]
}
