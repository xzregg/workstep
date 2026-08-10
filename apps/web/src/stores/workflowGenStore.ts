import { create } from 'zustand'
import { zhCNT } from '../i18n'

/** A session-scoped WS event (no task_id — keyed by session_id). */
export interface GenChatEvent {
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

export interface GenChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: 'running' | 'succeeded' | 'error'
  engine?: string
  model?: string
  prompt?: string
  error?: string
  created_at?: string
}

export interface GenProposalCard {
  id: string
  title: string
  summary: string
  steps: any
  nodeCount: number
}

export interface GenSessionState {
  /** Ordered conversation messages (user + assistant). */
  messages: GenChatMessage[]
  running: boolean
  /** Latest validated flow proposal cards from the coordinator. */
  latestProposals: GenProposalCard[]
  /** Human-readable reason when the latest proposals were rejected. */
  rejectionMessage?: string
}

interface GenState {
  sessions: Record<string, GenSessionState>
  newSession: (sessionId: string) => void
  addUserMessage: (sessionId: string, content: string) => void
  handleWsEvent: (event: GenChatEvent) => void
  resetSession: (sessionId: string) => void
}

const MAX_SESSIONS = 30

function emptySession(): GenSessionState {
  return { messages: [], running: false, latestProposals: [], rejectionMessage: '' }
}

function upsertSession(
  sessions: Record<string, GenSessionState>,
  sessionId: string,
  session: GenSessionState,
): Record<string, GenSessionState> {
  const next = { ...sessions, [sessionId]: session }
  const keys = Object.keys(next)
  if (keys.length > MAX_SESSIONS) {
    // Drop the oldest inserted sessions to bound memory usage.
    const drop = keys.length - MAX_SESSIONS
    for (const key of keys.slice(0, drop)) delete next[key]
  }
  return next
}

export const useWorkflowGenStore = create<GenState>((set) => ({
  sessions: {},

  newSession: (sessionId) =>
    set((s) => {
      if (s.sessions[sessionId]) return s
      return { sessions: upsertSession(s.sessions, sessionId, emptySession()) }
    }),

  addUserMessage: (sessionId, content) =>
    set((s) => {
      const session = s.sessions[sessionId] || emptySession()
      const message: GenChatMessage = {
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
        }),
      }
    }),

  handleWsEvent: (event) => {
    const sessionId = event.session_id
    if (!sessionId) return
    set((s) => {
      const session = s.sessions[sessionId] || emptySession()
      const messages = [...session.messages]
      let running = session.running
      let latestProposals = session.latestProposals
      let rejectionMessage = session.rejectionMessage

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
      } else if (event.type === 'flow_proposals') {
        const items = event.data.proposals
        if (Array.isArray(items)) {
          latestProposals = items
            .filter((item) => item && typeof item === 'object' && item.steps)
            .map((item) => ({
              id: String(item.id || ''),
              title: String(item.title || zhCNT('aiFlow.defaultProposalTitle')),
              summary: String(item.summary || ''),
              steps: item.steps,
              nodeCount: Number(item.nodeCount || 0),
            }))
        }
        rejectionMessage = ''
      } else if (event.type === 'flow_proposals_rejected') {
        latestProposals = []
        rejectionMessage = String(event.data.message || zhCNT('aiFlow.proposalRejected'))
      } else if (event.type === 'error') {
        running = false
        if (event.message_id) {
          const index = findIndex(event.message_id)
          if (index !== -1) {
            messages[index] = {
              ...messages[index],
              status: 'error',
              error: String(event.data.message || zhCNT('aiFlow.generateFailed')),
            }
          }
        }
      } else if (event.type === 'message_completed') {
        running = false
        if (event.message_id) {
          const index = findIndex(event.message_id)
          const status = event.data.status === 'error' ? 'error' : 'succeeded'
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
            })
          } else {
            messages[index] = {
              ...messages[index],
              content,
              status,
              error: status === 'error' ? content : messages[index].error,
            }
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
        }),
      }
    })
  },

  resetSession: (sessionId) =>
    set((s) => {
      const next = { ...s.sessions }
      delete next[sessionId]
      return { sessions: next }
    }),
}))
