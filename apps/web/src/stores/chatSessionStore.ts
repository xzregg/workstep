/**
 * chatSessionStore — Codex-style session chat stores.
 *
 * Message streaming reuses the generic assistant store (`assistantStore.ts`)
 * with the `session_chat` channel: sessions are keyed by the chat session id.
 * A companion list store tracks the project's sessions (flat, newest first)
 * and the per-project quick buttons (both come from the chat-sessions API).
 */

import { create } from 'zustand'
import {
  chatSessionApi,
  type ChatQuickButton,
  type ChatSessionSummary,
} from '../api/client.ts'
import { createAssistantStore } from './assistantStore.ts'

export const useChatSessionStore = createAssistantStore({
  channel: 'session_chat',
})

interface ChatListState {
  /** Project-level sessions (manual order, newest first), as returned by the API. */
  sessions: ChatSessionSummary[]
  quickButtons: ChatQuickButton[]
  listLoading: boolean

  fetchSessions: (projectId: string) => Promise<void>
  reorderSessions: (projectId: string, orderedIds: string[]) => Promise<void>
  addSession: (session: ChatSessionSummary) => void
  removeSession: (sessionId: string) => void
  renameSession: (sessionId: string, title: string) => void

  fetchQuickButtons: (projectId: string) => Promise<void>
  saveQuickButtons: (projectId: string, buttons: ChatQuickButton[]) => Promise<ChatQuickButton[]>
}

export const useChatListStore = create<ChatListState>((set, get) => ({
  sessions: [],
  quickButtons: [],
  listLoading: false,

  fetchSessions: async (projectId) => {
    if (!projectId || get().listLoading) return
    set({ listLoading: true })
    try {
      const { sessions } = await chatSessionApi.list(projectId)
      set({ sessions })
    } catch {
      // Keep whatever is cached; the next navigation retries.
    } finally {
      set({ listLoading: false })
    }
  },

  reorderSessions: async (projectId, orderedIds) => {
    const orderMap = new Map(orderedIds.map((id, index) => [id, index]))
    set((state) => {
      const sessions = [...state.sessions].sort(
        (a, b) =>
          (orderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER)
          - (orderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER),
      )
      return { sessions }
    })
    try {
      await chatSessionApi.reorder(projectId, orderedIds)
    } catch {
      await get().fetchSessions(projectId)
    }
  },

  addSession: (session) =>
    set((state) => {
      return { sessions: [session, ...state.sessions.filter((item) => item.id !== session.id)] }
    }),

  removeSession: (sessionId) =>
    set((state) => ({ sessions: state.sessions.filter((item) => item.id !== sessionId) })),

  renameSession: (sessionId, title) =>
    set((state) => ({
      sessions: state.sessions.map((item) =>
        item.id === sessionId ? { ...item, title } : item,
      ),
    })),

  fetchQuickButtons: async (projectId) => {
    if (!projectId) return
    try {
      const { buttons } = await chatSessionApi.quickButtons(projectId)
      set({ quickButtons: buttons })
    } catch {
      // Defaults come from the backend; keep the last known state.
    }
  },

  saveQuickButtons: async (projectId, buttons) => {
    const saved = await chatSessionApi.saveQuickButtons(projectId, buttons)
    set({ quickButtons: saved.buttons })
    return saved.buttons
  },
}))
