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

/** A session-scoped WS event (no task_id — keyed by session_id). */
export interface AssistantChatEvent {
  type: string
  data: Record<string, unknown>
  session_id?: string
  message_id?: string
  channel?: string
  engine?: string
  model?: string
  event_sequence?: number
  created_at?: string
  timestamp?: number
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
  return { messages: [], running: false, latestProposals: [], rejectionMessage: '' }
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
        return {
          sessions: upsertSession(s.sessions, sessionId, {
            ...session,
            messages: merged,
            running: running || session.running,
          }, maxSessions),
        }
      }),

    handleWsEvent: (event) => {
      const sessionId = event.session_id
      if (!sessionId || (config.channel && event.channel !== config.channel)) return
      set((s) => {
        const session = s.sessions[sessionId] || emptySession()
        const messages = [...session.messages]
        let running = session.running
        let latestProposals = session.latestProposals
        let rejectionMessage = session.rejectionMessage
        let latestResult = session.latestResult

        const findIndex = (id?: string) =>
          id ? messages.findIndex((m) => m.id === id) : -1

        if (event.type === 'message_started' && event.message_id) {
          const index = findIndex(event.message_id)
          if (index === -1) {
            messages.push({
              id: event.message_id,
              role: 'assistant',
              content: '',
              status: 'running',
              engine: event.engine,
              model: event.model,
              prompt: String(event.data.prompt || ''),
              created_at: event.created_at,
              events: [],
            })
          }
          running = true
        } else if (event.type === 'text_delta' && event.message_id) {
          const index = findIndex(event.message_id)
          if (index !== -1) {
            const current = messages[index]
            messages[index] = {
              ...current,
              content: current.content + String(event.data.delta || ''),
              events: [...(current.events || []), event],
            }
          }
        } else if (event.type === 'message_snapshot' && event.message_id) {
          const index = findIndex(event.message_id)
          if (index !== -1) {
            messages[index] = {
              ...messages[index],
              content: String(event.data.content || messages[index].content),
            }
          }
        } else if (event.type === config.proposalEvent && config.proposalExtractor) {
          const items = config.proposalExtractor(event.data)
          if (items.length > 0 || event.data.proposals !== undefined) {
            latestProposals = items
          }
          rejectionMessage = ''
        } else if (event.type === config.rejectionEvent) {
          latestProposals = []
          rejectionMessage = config.rejectionMessageExtractor
            ? config.rejectionMessageExtractor(event.data)
            : fallbackRejected()
        } else if (event.type === config.resultEvent && config.resultExtractor) {
          latestResult = config.resultExtractor(event.data)
        } else if (event.type === 'error') {
          running = false
          if (event.message_id) {
            const index = findIndex(event.message_id)
            if (index !== -1) {
              messages[index] = {
                ...messages[index],
                status: 'error',
                error: String(
                  event.data.message || fallbackFailed(),
                ),
              }
            }
          }
        } else if (event.type === 'message_completed') {
          running = false
          if (event.message_id) {
            const index = findIndex(event.message_id)
            const status = event.data.status === 'error'
              ? 'error'
              : event.data.status === 'stopped'
                ? 'stopped'
                : 'succeeded'
            const content = event.data.content
              ? String(event.data.content)
              : index !== -1
                ? messages[index].content
                : ''
            if (index === -1) {
              messages.push({
                id: event.message_id,
                role: 'assistant',
                content,
                status,
                engine: event.engine,
                model: event.model,
                error: status === 'error' ? content : undefined,
                created_at: event.created_at,
                ended_at: typeof event.data.ended_at === 'string'
                  ? event.data.ended_at
                  : event.created_at,
                events: [],
              })
            } else {
              messages[index] = {
                ...messages[index],
                content,
                status,
                error: status === 'error' ? content : messages[index].error,
                ended_at: typeof event.data.ended_at === 'string'
                  ? event.data.ended_at
                  : event.created_at,
              }
            }
          }
        } else if (
          (
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
          && event.message_id
        ) {
          // Preserve process events so the message can render text and tools in sequence.
          const index = findIndex(event.message_id)
          if (index !== -1) {
            const current = messages[index]
            messages[index] = {
              ...current,
              events: [...(current.events || []), event],
            }
          }
        }

        return {
          sessions: upsertSession(s.sessions, sessionId, {
            ...session,
            messages,
            running,
            latestProposals,
            rejectionMessage,
            latestResult,
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
