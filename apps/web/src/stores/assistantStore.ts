/**
 * assistantStore — generic chat store for any LLM assistant conversation.
 *
 * Every assistant chat (task coordinator, AI flow designer, …) shares the
 * same session lifecycle over the global WebSocket: messages are keyed by a
 * session id, live events (message_started / text_delta / thinking_delta /
 * tool_use / tool_result / usage / interaction_request / interaction_response / message_snapshot /
 * message_completed / error) update the same
 * message list, and assistant-specific "structured choices" (e.g. flow
 * proposals) are configured per assistant. Adding a new assistant only
 * requires calling `createAssistantStore(config)`; no copied store logic.
 */

import { create } from 'zustand'
import type { EngineInputItem } from '../api/client.ts'
import {
  CUSTOM,
  appendMessageContent,
  availableCommandInputItems,
  customValue,
  isCustom,
  isReasoningEvent,
  isToolEvent,
  messageId,
} from '../utils/agui.ts'

/** A session-scoped WS event — AG-UI 标准事件（无 task_id，按 session_id 分流）。 */
export interface AssistantChatEvent {
  type: string
  /** Persisted JSONL sequence number (distinct from AG-UI live sequence). */
  seq?: number
  data?: Record<string, unknown>
  session_id?: string
  message_id?: string
  channel?: string
  engine?: string
  model?: string
  event_sequence?: number
  created_at?: string
  timestamp?: number
  /** AG-UI 标准字段 */
  messageId?: string
  name?: string
  value?: Record<string, unknown>
  role?: string
  delta?: string
  phase?: string
  source_item_id?: string
  content?: string
  prompt?: string
  status?: string
  error?: string
  ended_at?: string
  toolCallId?: string
  toolCallName?: string
  args?: unknown
  output?: unknown
  isError?: boolean
  task_id?: string
  step_key?: string
  sequence?: number
  actor?: { id?: string; name?: string; device_id?: string; device_name?: string }
}

export interface AssistantChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: 'running' | 'succeeded' | 'stopped' | 'error'
  engine?: string
  model?: string
  prompt?: string
  error?: string
  created_at?: string
  ended_at?: string
  author_id?: string
  author_name?: string
  author_device_id?: string
  author_device_name?: string
  /** Process events (thinking/usage/…), consumed by ProcessTrace + footer. */
  events?: AssistantChatEvent[]
  event_summary?: {
    event_count?: number
    last_event_seq?: number
    thought_characters?: number
    commentary_characters?: number
    tool_count?: number
  }
  event_detail?: {
    available?: boolean
    loaded?: boolean
    loading?: boolean
    complete?: boolean
    next_cursor?: number | null
    error?: string
  }
}

export interface AssistantProposalCard {
  id: string
  title: string
  workflowName?: string
  summary: string
  steps: any
  nodeCount: number
  autoApply?: boolean
  /** Stages this proposal touched (patch edits only), for partial apply. */
  stageChanges?: AssistantStageChange[]
  /** Raw incremental patch when the proposal came from a patch edit. */
  patch?: {
    upsertNodes?: Record<string, unknown>[]
    removeNodeIds?: number[]
    connections?: Record<string, unknown>[]
  }
}

/** One stage touched by an incremental flow patch. */
export interface AssistantStageChange {
  id: number
  key: string
  title: string
  change: 'added' | 'updated' | 'removed'
}

export interface AssistantSessionState {
  /** Ordered conversation messages (user + assistant). */
  messages: AssistantChatMessage[]
  running: boolean
  /** Latest validated structured choice cards from the assistant. */
  latestProposals: AssistantProposalCard[]
  /** Human-readable reason when the latest choices were rejected. */
  rejectionMessage?: string
  /** Latest assistant-specific structured result (e.g. a generated task draft). */
  latestResult?: Record<string, unknown>
  /** A2UI 载荷（``CUSTOM a2ui.surface``），按 messageId 追加。 */
  a2uiMessages?: Record<string, Record<string, unknown>[]>
  /** Latest full command catalog advertised by this engine session. */
  availableCommands?: EngineInputItem[]
}

export interface AssistantStore {
  sessions: Record<string, AssistantSessionState>
  newSession: (sessionId: string) => void
  addUserMessage: (sessionId: string, content: string) => void
  hydrateSession: (
    sessionId: string,
    messages: AssistantChatMessage[],
    running?: boolean,
  ) => void
  handleWsEvent: (event: AssistantChatEvent) => void
  setMessageEventLoading: (
    sessionId: string,
    messageId: string,
    loading: boolean,
    error?: string,
  ) => void
  setMessageEventDetails: (
    sessionId: string,
    messageId: string,
    events: AssistantChatEvent[],
    detail: { complete: boolean; next_cursor: number | null },
  ) => void
  markStopped: (sessionId: string) => void
  resetSession: (sessionId: string) => void
}

export interface AssistantStoreConfig {
  /** Only accept WebSocket events emitted by this assistant channel. */
  channel?: string
  /** WS event type carrying structured choice cards (e.g. 'flow_proposals'). */
  proposalEvent?: string
  /** Extract choice cards from a proposal event's data payload. */
  proposalExtractor?: (
    data: Record<string, unknown>,
  ) => AssistantProposalCard[]
  /** WS event type signalling that structured choices were rejected. */
  rejectionEvent?: string
  /** Extract the human-readable rejection message. */
  rejectionMessageExtractor?: (data: Record<string, unknown>) => string
  /** Max cached sessions (LRU-ish by insertion order). */
  maxSessions?: number
  /** Fallback text when a rejection event has no message. */
  proposalRejectedText?: () => string
  /** Fallback text for an error event with no message. */
  generateFailedText?: () => string
  /** WS event carrying one non-choice structured result. */
  resultEvent?: string
  /** Normalize the structured result before storing it in the session. */
  resultExtractor?: (
    data: Record<string, unknown>,
  ) => Record<string, unknown> | undefined
}

const DEFAULT_MAX_SESSIONS = 30

/**
 * 单条消息在前端 live 保留的过程事件上限。子代理/长工具回合可产生上万条事件，
 * 不设上限会让 pushEvent 的整数组复制退化为 O(n²) 并让时间线全量渲染 → 主线程冻结。
 * 超过上限只保留最近若干条；完整事件流服务端持久化，展开时经 messageEvents 懒加载。
 */
const MAX_LIVE_EVENTS_PER_MESSAGE = 2000

/** 封顶追加：超限只保留最近 N 条（live 增量与正文 chunk 共用同一上限）。 */
function appendCappedEvent(
  events: AssistantChatEvent[] | undefined,
  event: AssistantChatEvent,
): AssistantChatEvent[] {
  const combined = [...(events || []), event]
  return combined.length > MAX_LIVE_EVENTS_PER_MESSAGE
    ? combined.slice(-MAX_LIVE_EVENTS_PER_MESSAGE)
    : combined
}

/** 封顶追加 A2UI 载荷：流式界面更新可产生任意多条，不能让缓存无限增长。 */
function appendCappedA2uiPayload(
  payloads: Record<string, unknown>[] | undefined,
  payload: Record<string, unknown>,
): Record<string, unknown>[] {
  const combined = [...(payloads || []), payload]
  return combined.length > MAX_LIVE_EVENTS_PER_MESSAGE
    ? combined.slice(-MAX_LIVE_EVENTS_PER_MESSAGE)
    : combined
}

/** 历史消息进 store 前同样封顶：条数可达数万，全量常驻会随会话缓存叠加撑爆内存。 */
function capHistoryEvents(message: AssistantChatMessage): AssistantChatMessage {
  return message.events && message.events.length > MAX_LIVE_EVENTS_PER_MESSAGE
    ? { ...message, events: message.events.slice(-MAX_LIVE_EVENTS_PER_MESSAGE) }
    : message
}

function eventIdentity(event: AssistantChatEvent): string {
  const sequence = event.seq ?? event.event_sequence ?? event.sequence
  if (sequence !== undefined) return `sequence:${sequence}:${event.type}`
  return JSON.stringify([
    event.type,
    event.messageId ?? event.message_id,
    event.timestamp ?? event.created_at,
    event.toolCallId,
    event.name,
  ])
}

function mergeMessageEvents(
  persisted: AssistantChatEvent[],
  live: AssistantChatEvent[],
): AssistantChatEvent[] {
  const merged = new Map<string, AssistantChatEvent>()
  for (const event of [...persisted, ...live]) merged.set(eventIdentity(event), event)
  return [...merged.values()].sort((left, right) => {
    const a = left.seq ?? left.event_sequence ?? left.sequence
    const b = right.seq ?? right.event_sequence ?? right.sequence
    if (a === undefined || b === undefined) return 0
    return a - b
  })
}

function emptySession(): AssistantSessionState {
  return {
    messages: [],
    running: false,
    latestProposals: [],
    rejectionMessage: '',
    a2uiMessages: {},
  }
}

function upsertSession(
  sessions: Record<string, AssistantSessionState>,
  sessionId: string,
  session: AssistantSessionState,
  maxSessions: number,
): Record<string, AssistantSessionState> {
  const next = { ...sessions, [sessionId]: session }
  const keys = Object.keys(next)
  if (keys.length > maxSessions) {
    // Drop the oldest inserted sessions to bound memory usage.
    const drop = keys.length - maxSessions
    for (const key of keys.slice(0, drop)) delete next[key]
  }
  return next
}

/** Create a zustand assistant chat store from declarative per-assistant config. */
export function createAssistantStore(
  config: AssistantStoreConfig = {},
) {
  const maxSessions = config.maxSessions ?? DEFAULT_MAX_SESSIONS
  const fallbackRejected = config.proposalRejectedText ?? (() => '提案未通过校验')
  const fallbackFailed = config.generateFailedText ?? (() => '生成失败')

  return create<AssistantStore>((set) => ({
    sessions: {},

    newSession: (sessionId) =>
      set((s) => {
        if (s.sessions[sessionId]) return s
        return {
          sessions: upsertSession(s.sessions, sessionId, emptySession(), maxSessions),
        }
      }),

    addUserMessage: (sessionId, content) =>
      set((s) => {
        const session = s.sessions[sessionId] || emptySession()
        const message: AssistantChatMessage = {
          id: `user-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          role: 'user',
          content,
          status: 'succeeded',
          created_at: new Date().toISOString(),
        }
        return {
          sessions: upsertSession(s.sessions, sessionId, {
            ...session,
            messages: [...session.messages, message],
          }, maxSessions),
        }
      }),

    hydrateSession: (sessionId, messages, running = false) =>
      set((s) => {
        const session = s.sessions[sessionId] || emptySession()
        // Merge: keep any live messages (running turn) and backfill history.
        const existingIds = new Set(session.messages.map((m) => m.id))
        const merged = [
          ...messages.filter((m) => !existingIds.has(m.id)).map(capHistoryEvents),
          ...session.messages,
        ]
        // 历史事件兼容两种形状：内部词汇（``type: 'a2ui'``，data 为载荷）与
        // 对外 AG-UI CUSTOM（``type: 'CUSTOM'``、``name: 'a2ui.surface'``）。
        const historyPayloads = (events: AssistantChatEvent[] | undefined, internalType: string, aguiName: string) =>
          (events ?? []).flatMap((event) => {
            if (event.type === internalType && event.data && typeof event.data === 'object') {
              return [event.data as Record<string, unknown>]
            }
            if (event.type === 'CUSTOM' && event.name === aguiName && event.value && typeof event.value === 'object') {
              return [event.value as Record<string, unknown>]
            }
            return []
          })
        // 内部事件类型 = AG-UI 名去掉 ``workstep.`` 前缀（如 flow_proposals）。
        const internalTypeOf = (aguiName?: string) =>
          aguiName ? (aguiName.startsWith('workstep.') ? aguiName.slice('workstep.'.length) : aguiName) : undefined
        // 从历史事件重建 A2UI 界面（fence 仅作旧数据回退）。
        const a2uiMessages = { ...(session.a2uiMessages ?? {}) }
        // 最近一轮结构化提案卡片与拒绝原因随历史恢复，重开对话框后仍可应用。
        let latestProposals = session.latestProposals
        let rejectionMessage = session.rejectionMessage
        for (const message of messages) {
          const a2uiPayloads = historyPayloads(message.events, 'a2ui', CUSTOM.a2ui)
          if (a2uiPayloads.length > 0) {
            a2uiMessages[message.id] = a2uiPayloads.slice(-MAX_LIVE_EVENTS_PER_MESSAGE)
          }
          const proposalEvent = config.proposalEvent
          if (proposalEvent && config.proposalExtractor) {
            const proposalPayloads = historyPayloads(
              message.events,
              internalTypeOf(proposalEvent) ?? '',
              proposalEvent,
            )
            const proposals = proposalPayloads.flatMap((data) => config.proposalExtractor!(data))
            if (proposals.length > 0) {
              latestProposals = proposals
              rejectionMessage = ''
            }
          }
          const rejectionEvent = config.rejectionEvent
          if (rejectionEvent && config.rejectionMessageExtractor) {
            const rejected = historyPayloads(
              message.events,
              internalTypeOf(rejectionEvent) ?? '',
              rejectionEvent,
            )
            if (rejected.length > 0) {
              latestProposals = []
              rejectionMessage = config.rejectionMessageExtractor(rejected[rejected.length - 1])
            }
          }
        }
        return {
          sessions: upsertSession(s.sessions, sessionId, {
            ...session,
            messages: merged,
            running: running || session.running || merged.some((message) => (
              message.role === 'assistant' && message.status === 'running'
            )),
            a2uiMessages,
            latestProposals,
            rejectionMessage,
          }, maxSessions),
        }
      }),

    handleWsEvent: (event) => {
      const sessionId = event.session_id
      if (!sessionId || (config.channel && event.channel !== config.channel)) return
      const mid = messageId(event)
      set((s) => {
        const session = s.sessions[sessionId] || emptySession()
        const messages = [...session.messages]
        let running = session.running
        let latestProposals = session.latestProposals
        let rejectionMessage = session.rejectionMessage
        let latestResult = session.latestResult
        let a2uiMessages = session.a2uiMessages
        let availableCommands = session.availableCommands

        const findIndex = (id?: string) =>
          id ? messages.findIndex((m) => m.id === id) : -1

        const pushEvent = (id?: string) => {
          if (!id) return
          const index = findIndex(id)
          if (index !== -1) {
            // Live 事件封顶：子代理等异常回合可产生上万条事件，逐条整数组复制是
            // O(n²)（即便切走仍在后台跑，占满主线程），且 buildMessageTimeline /
            // ProcessTrace 会全量渲染。只保留最近 N 条；完整日志服务端已持久化，
            // 可经 messageEvents 按需懒加载。文本正文走 content，不在此裁剪。
            messages[index] = {
              ...messages[index],
              events: appendCappedEvent(messages[index].events, event),
            }
          }
        }

        if (isCustom(event, CUSTOM.availableCommandsUpdate)) {
          availableCommands = availableCommandInputItems(customValue(event))
          pushEvent(mid)
        } else if (event.type === 'TEXT_MESSAGE_START' && mid) {
          const index = findIndex(mid)
          const prompt = String(
            event.prompt
            ?? (event.data as Record<string, unknown> | undefined)?.prompt
            ?? '',
          )
          const isUserEvent = event.role === 'user'
          const userStatus: AssistantChatMessage['status'] = 'succeeded'
          if (index === -1) {
            // 自己的乐观气泡使用 `user-` 前缀的临时 id；后端确认后把该气泡
            // 换成持久化 messageId，避免 A/B 双方看到重复的用户消息。
            const optimisticIndex = isUserEvent
              ? messages.findIndex((m) => (
                  m.role === 'user'
                  && String(m.id).startsWith('user-')
                  && (m.content || '').trim() === String(event.content ?? '').trim()
                ))
              : -1
            if (optimisticIndex !== -1) {
              messages[optimisticIndex] = {
                ...messages[optimisticIndex],
                id: mid,
                role: 'user',
                content: String(event.content ?? messages[optimisticIndex].content),
                status: userStatus,
                engine: event.engine,
                model: event.model,
                prompt,
                created_at: event.created_at || messages[optimisticIndex].created_at,
                author_id: event.actor?.id,
                author_name: event.actor?.name,
                author_device_id: event.actor?.device_id,
                author_device_name: event.actor?.device_name,
              }
            } else {
              messages.push({
                id: mid,
                role: isUserEvent ? 'user' : 'assistant',
                content: isUserEvent ? String(event.content ?? '') : '',
                status: isUserEvent ? userStatus : 'running',
                engine: event.engine,
                model: event.model,
                prompt,
                created_at: event.created_at,
                author_id: event.actor?.id,
                author_name: event.actor?.name,
                author_device_id: event.actor?.device_id,
                author_device_name: event.actor?.device_name,
                events: [],
              })
            }
          } else {
            messages[index] = {
              ...messages[index],
              role: isUserEvent ? 'user' : messages[index].role,
              content: isUserEvent && event.content != null
                ? String(event.content)
                : messages[index].content,
              status: isUserEvent ? userStatus : 'running',
              prompt: prompt || messages[index].prompt,
            }
          }
          running = true
        } else if (event.type === 'TEXT_MESSAGE_CHUNK' && mid) {
          const index = findIndex(mid)
          if (index === -1) {
            messages.push({
              id: mid,
              role: event.role === 'user' ? 'user' : 'assistant',
              content: appendMessageContent('', event),
              status: 'running',
              engine: event.engine,
              model: event.model,
              created_at: event.created_at,
              author_id: event.actor?.id,
              author_name: event.actor?.name,
              author_device_id: event.actor?.device_id,
              author_device_name: event.actor?.device_name,
              events: [event],
            })
          } else {
            const current = messages[index]
            messages[index] = {
              ...current,
              role: event.role === 'user' ? 'user' : current.role,
              content: appendMessageContent(current.content, event),
              // chunk 事件同样封顶：长回复每个 token 一条，不封顶则单条消息
              // 事件数组无界增长（且每次追加整数组复制 → O(n²)）。
              events: appendCappedEvent(current.events, event),
            }
          }
          if (event.role !== 'user') running = true
        } else if (event.type === 'TEXT_MESSAGE_CONTENT' && mid) {
          const index = findIndex(mid)
          if (index !== -1) {
            messages[index] = {
              ...messages[index],
              content: appendMessageContent(messages[index].content, event),
            }
          }
        } else if (
          isCustom(event, config.proposalEvent ?? '')
          && config.proposalExtractor
        ) {
          const value = customValue(event)
          const items = config.proposalExtractor(value)
          if (items.length > 0 || value.proposals !== undefined) {
            latestProposals = items
          }
          rejectionMessage = ''
        } else if (isCustom(event, config.rejectionEvent ?? '')) {
          latestProposals = []
          rejectionMessage = config.rejectionMessageExtractor
            ? config.rejectionMessageExtractor(customValue(event))
            : fallbackRejected()
        } else if (
          isCustom(event, config.resultEvent ?? '')
          && config.resultExtractor
        ) {
          latestResult = config.resultExtractor(customValue(event))
        } else if (isCustom(event, CUSTOM.error) || event.type === 'error') {
          running = false
          if (mid) {
            const index = findIndex(mid)
            if (index !== -1) {
              messages[index] = {
                ...messages[index],
                status: 'error',
                error: String(
                  isCustom(event, CUSTOM.error)
                    ? customValue(event).message
                    : (event.data as Record<string, unknown> | undefined)?.message
                  || fallbackFailed(),
                ),
              }
            }
          }
        } else if (event.type === 'TEXT_MESSAGE_END' && mid) {
          running = false
          const index = findIndex(mid)
          const status = event.status === 'error'
            ? 'error'
            : event.status === 'stopped'
              ? 'stopped'
              : 'succeeded'
          const content = typeof event.content === 'string'
            ? event.content
            : index !== -1
              ? messages[index].content
              : ''
          if (index === -1) {
            messages.push({
              id: mid,
              role: 'assistant',
              content,
              status,
              engine: event.engine,
              model: event.model,
              error: status === 'error' ? event.error ?? content : undefined,
              created_at: event.created_at,
              ended_at: event.ended_at ?? event.created_at,
              events: [],
            })
          } else {
            messages[index] = {
              ...messages[index],
              content,
              status,
              error: status === 'error' ? event.error ?? content : messages[index].error,
              ended_at: event.ended_at ?? event.created_at,
            }
          }
        } else if (isCustom(event, CUSTOM.a2ui) && mid) {
          a2uiMessages = {
            ...(a2uiMessages ?? {}),
            [mid]: appendCappedA2uiPayload(
              a2uiMessages?.[mid],
              customValue(event),
            ),
          }
        } else if ((isReasoningEvent(event) || isToolEvent(event)) && mid) {
          // Preserve process events so the message can render text and tools in sequence.
          pushEvent(mid)
        } else if (
          mid && (
            isCustom(event, CUSTOM.usage)
            || isCustom(event, CUSTOM.plan)
            || isCustom(event, CUSTOM.planUpdate)
            || isCustom(event, CUSTOM.planRemoved)
            || isCustom(event, CUSTOM.interactionRequest)
            || isCustom(event, CUSTOM.interactionResponse)
            || isCustom(event, CUSTOM.subagent)
            || isCustom(event, CUSTOM.compacted)
            || isCustom(event, CUSTOM.sessionStarted)
            || isCustom(event, CUSTOM.engineState)
            || isCustom(event, CUSTOM.sessionInfoUpdate)
            || isCustom(event, CUSTOM.availableCommandsUpdate)
            || isCustom(event, CUSTOM.configOptionUpdate)
            || isCustom(event, CUSTOM.currentModeUpdate)
            || isCustom(event, CUSTOM.mcpMessage)
            || isCustom(event, CUSTOM.elicitationCompleted)
            || isCustom(event, CUSTOM.acpRaw)
          )
        ) {
          pushEvent(mid)
        } else if (
          mid && (
            event.type === 'thinking_delta'
            || event.type === 'tool_use'
            || event.type === 'tool_input_delta'
            || event.type === 'tool_result'
            || event.type === 'usage'
            || event.type === 'interaction_request'
            || event.type === 'interaction_response'
            || event.type === 'plan'
            || event.type === 'subagent'
          )
        ) {
          pushEvent(mid)
        }

        return {
          sessions: upsertSession(s.sessions, sessionId, {
            ...session,
            messages,
            running,
            latestProposals,
            rejectionMessage,
            latestResult,
            a2uiMessages,
            availableCommands,
          }, maxSessions),
        }
      })
    },

    setMessageEventLoading: (sessionId, messageId, loading, error = '') =>
      set((s) => {
        const session = s.sessions[sessionId]
        if (!session) return s
        return {
          sessions: upsertSession(s.sessions, sessionId, {
            ...session,
            messages: session.messages.map((message) => message.id === messageId
              ? {
                  ...message,
                  event_detail: {
                    ...message.event_detail,
                    available: true,
                    loading,
                    error,
                  },
                }
              : message),
          }, maxSessions),
        }
      }),

    setMessageEventDetails: (sessionId, messageId, events, detail) =>
      set((s) => {
        const session = s.sessions[sessionId]
        if (!session) return s
        return {
          sessions: upsertSession(s.sessions, sessionId, {
            ...session,
            messages: session.messages.map((message) => message.id === messageId
              ? {
                  ...message,
                  events: mergeMessageEvents(events, message.events ?? []),
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
              : message),
          }, maxSessions),
        }
      }),

    markStopped: (sessionId) =>
      set((s) => {
        const session = s.sessions[sessionId]
        if (!session) return s
        return {
          sessions: upsertSession(s.sessions, sessionId, {
            ...session,
            running: false,
            messages: session.messages.map((message) => (
              message.role === 'assistant' && message.status === 'running'
                ? { ...message, status: 'stopped', ended_at: new Date().toISOString() }
                : message
            )),
          }, maxSessions),
        }
      }),

    resetSession: (sessionId) =>
      set((s) => {
        const next = { ...s.sessions }
        delete next[sessionId]
        return { sessions: next }
      }),
  }))
}
