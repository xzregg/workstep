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
}

export interface AssistantProposalCard {
  id: string
  title: string
  summary: string
  steps: any
  nodeCount: number
  autoApply?: boolean
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
          ...messages.filter((m) => !existingIds.has(m.id)),
          ...session.messages,
        ]
        // 从历史事件的 a2ui.surface 载荷重建 A2UI 界面（fence 仅作旧数据回退）。
        const a2uiMessages = { ...(session.a2uiMessages ?? {}) }
        for (const message of messages) {
          const payloads = (message.events ?? []).filter((event) => (
            event.type === 'CUSTOM'
            && event.name === CUSTOM.a2ui
            && event.value && typeof event.value === 'object'
          )).map((event) => event.value as Record<string, unknown>)
          if (payloads.length > 0) {
            a2uiMessages[message.id] = payloads
          }
        }
        return {
          sessions: upsertSession(s.sessions, sessionId, {
            ...session,
            messages: merged,
            running: running || session.running,
            a2uiMessages,
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
            messages[index] = {
              ...messages[index],
              events: [...(messages[index].events || []), event],
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
          if (index === -1) {
            messages.push({
              id: mid,
              role: event.role === 'user' ? 'user' : 'assistant',
              content: '',
              status: 'running',
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
          } else {
            messages[index] = {
              ...messages[index],
              role: event.role === 'user' ? 'user' : messages[index].role,
              status: 'running',
              prompt: prompt || messages[index].prompt,
            }
          }
          running = true
        } else if (event.type === 'TEXT_MESSAGE_CHUNK' && mid) {
          const index = findIndex(mid)
          const delta = String(event.delta ?? '')
          if (index === -1) {
            messages.push({
              id: mid,
              role: event.role === 'user' ? 'user' : 'assistant',
              content: delta,
              status: 'running',
              engine: event.engine,
              model: event.model,
              created_at: event.created_at,
              author_id: event.actor?.id,
              author_name: event.actor?.name,
              author_device_id: event.actor?.device_id,
              author_device_name: event.actor?.device_name,
              events: [],
            })
          } else {
            const current = messages[index]
            messages[index] = {
              ...current,
              role: event.role === 'user' ? 'user' : current.role,
              content: current.content + delta,
              events: [...(current.events || []), event],
            }
          }
        } else if (event.type === 'TEXT_MESSAGE_CONTENT' && mid) {
          const index = findIndex(mid)
          if (index !== -1) {
            messages[index] = {
              ...messages[index],
              content: typeof event.content === 'string'
                ? event.content
                : String(event.delta ?? messages[index].content),
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
            [mid]: [...(a2uiMessages?.[mid] ?? []), customValue(event)],
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
