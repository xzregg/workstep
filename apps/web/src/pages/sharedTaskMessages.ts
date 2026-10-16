import { appendMessageContent, isCommentaryEvent } from '../utils/agui'

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
  return !message.event_detail?.loaded && Array.isArray(message.events) && message.events.length > MAX_LIVE_SHARED_EVENTS
    ? { ...message, events: message.events.slice(-MAX_LIVE_SHARED_EVENTS) }
    : message
}

/** Apply one live event without mutating an earlier message snapshot. */
export function applySharedMessageEvent(messages: SharedMessage[], event: SharedEvent): SharedMessage[] {
  const kind = event?.type
  const messageId = event?.messageId ?? event?.message_id
  const isText = ['text_delta', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CHUNK', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END'].includes(kind)
  const isProcess = ['thinking_delta', 'REASONING_MESSAGE_CHUNK', 'tool_use', 'tool_input_delta',
    'tool_result', 'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_CHUNK', 'TOOL_CALL_RESULT',
    'interaction_request', 'interaction_response', 'CUSTOM'].includes(kind)
  const isStatus = ['status', 'done', 'RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR'].includes(kind)
  if ((!isText && !isProcess && !isStatus) || !messageId) return messages
  const index = messages.findIndex(message => message.id === messageId)
  const restarted = kind === 'TEXT_MESSAGE_START' && event.retry === true
  const existing: SharedMessage = !restarted && messages[index] || {
    schedule_run_id: event.schedule_run_id,
    id: messageId, role: event.role ?? 'assistant', content: '', events: [],
    channel: event.channel ?? 'execution', step_key: event.step_key,
    engine: event.engine, model: event.model, run_status: 'running',
    created_at: event.created_at ?? new Date().toISOString(),
    started_at: event.started_at ?? event.created_at ?? new Date().toISOString(), ended_at: null,
    author_id: event.actor?.id, author_name: event.actor?.name,
    author_device_id: event.actor?.device_id, author_device_name: event.actor?.device_name,
  }
  const updated: SharedMessage = { ...existing, ...(event.schedule_run_id ? { schedule_run_id: event.schedule_run_id } : {}) }
  if (isText) {
    updated.content = kind === 'text_delta'
      ? (existing.content ?? '') + (event.delta ?? event.text ?? '')
      : appendMessageContent(existing.content ?? '', { ...event, delta: event.delta ?? event.text })
    if (kind === 'TEXT_MESSAGE_END' && typeof event.content === 'string') updated.content = event.content
    if (kind === 'TEXT_MESSAGE_START') {
      updated.prompt = event.prompt ?? existing.prompt
      updated.artifact_round = event.artifact_round ?? existing.artifact_round
    }
  }
  if (isProcess || isCommentaryEvent(event)) {
    updated.events = existing.event_detail?.loaded || existing.event_detail?.loaded_cursor !== undefined
      ? [...(existing.events ?? []), event] : appendCappedSharedEvent(existing.events, event)
  }
  if (kind === 'CUSTOM' && event.name === 'workstep.usage') updated.usage = event.value
  if (kind === 'CUSTOM' && event.name === 'workstep.action_proposal') {
    const proposal = event.value?.proposal ?? event.value
    if (proposal?.id) updated.proposals = [
      ...(existing.proposals ?? []).filter((item: any) => item.id !== proposal.id), proposal,
    ]
  }
  const status = kind === 'CUSTOM' && event.name === 'workstep.status' ? event.value?.status : event.status
  if (isStatus || kind === 'TEXT_MESSAGE_END' || kind === 'CUSTOM' && event.name === 'workstep.status') {
    updated.run_status = status ?? (kind === 'RUN_FINISHED' || kind === 'TEXT_MESSAGE_END' || kind === 'done'
      ? 'succeeded' : kind === 'RUN_ERROR' ? 'failed' : existing.run_status)
    if (['succeeded', 'completed', 'done', 'passed', 'ready', 'failed', 'cancelled', 'error'].includes(updated.run_status)) {
      updated.ended_at = event.ended_at ?? event.created_at ?? existing.ended_at ?? new Date().toISOString()
    }
  }
  if (index < 0) return [...messages, updated]
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
      const detail = message.event_detail
      const cursor = detail?.loaded_cursor ?? (detail?.loaded ? detail.last_event_seq : undefined)
      if ((!detail?.loaded && cursor === undefined && !detail?.loading)
        || message.event_log_path !== fresh.event_log_path
        || message.step_run_id !== fresh.step_run_id
        || typeof cursor === 'number' && typeof fresh.event_detail?.last_event_seq === 'number'
          && fresh.event_detail.last_event_seq < cursor) return fresh
      return { ...fresh, events: message.events, event_detail: {
        ...fresh.event_detail, ...detail,
        last_event_seq: fresh.event_detail?.last_event_seq,
        loaded_cursor: cursor,
        loaded: cursor === fresh.event_detail?.last_event_seq,
      } }
    })
  return [...merged, ...incoming.values()]
}
