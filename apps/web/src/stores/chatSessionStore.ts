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

export function pinChannelSessions(sessions: ChatSessionSummary[]): ChatSessionSummary[] {
  return [...sessions].sort((a, b) =>
    Number(b.source === 'channel') - Number(a.source === 'channel'),
  )
}

export function mergeChatSessionRunningState(
  sessions: ChatSessionSummary[],
  liveState: Record<string, boolean>,
): Record<string, boolean> {
  return {
    ...Object.fromEntries(sessions.map((session) => [session.id, Boolean(session.running)])),
    ...liveState,
  }
}

/** Click context for multi-select toggling. */
export interface SelectOptions {
  /** Cmd/Ctrl held → toggle individual selection. */
  meta?: boolean
  /** Shift held → range select from anchor. */
  shift?: boolean
}

interface ChatListState {
  /** Sessions grouped by project so multiple expanded projects cannot share rows. */
  sessionsByProject: Record<string, ChatSessionSummary[]>
  quickButtons: ChatQuickButton[]
  listLoadingByProject: Record<string, boolean>

  // ── Multi-select ──
  /** Session IDs currently selected for bulk operations. */
  selectedIds: Set<string>
  /** The project that owns the current selection; prevents cross-project bulk actions. */
  selectionProjectId: string | null
  /** Last clicked session used as anchor for Shift+Click range select. */
  selectAnchor: string | null
  /** True while a bulk-delete request is in flight. */
  bulkDeleting: boolean

  fetchSessions: (projectId: string) => Promise<void>
  reorderSessions: (projectId: string, orderedIds: string[]) => Promise<void>
  addSession: (session: ChatSessionSummary) => void
  removeSession: (sessionId: string) => void
  renameSession: (sessionId: string, title: string) => void

  /** Update selection based on click modifiers (plain / Cmd / Shift). */
  handleSelect: (id: string, opts: SelectOptions, projectId?: string) => void
  /** Clear all selection and reset the anchor. */
  clearSelection: () => void
  /** Delete multiple sessions via the bulk API; removes them from local state. */
  bulkRemove: (projectId: string) => Promise<{ deleted: number; skipped: number }>

  fetchQuickButtons: (projectId: string) => Promise<void>
  saveQuickButtons: (projectId: string, buttons: ChatQuickButton[]) => Promise<ChatQuickButton[]>
}

export const useChatListStore = create<ChatListState>((set, get) => ({
  sessionsByProject: {},
  quickButtons: [],
  listLoadingByProject: {},

  selectedIds: new Set<string>(),
  selectionProjectId: null,
  selectAnchor: null,
  bulkDeleting: false,

  fetchSessions: async (projectId) => {
    if (!projectId || get().listLoadingByProject[projectId]) return
    set((state) => ({
      listLoadingByProject: { ...state.listLoadingByProject, [projectId]: true },
      selectedIds: new Set(),
      selectionProjectId: null,
      selectAnchor: null,
    }))
    try {
      const { sessions } = await chatSessionApi.list(projectId)
      set((state) => ({
        sessionsByProject: { ...state.sessionsByProject, [projectId]: pinChannelSessions(sessions) },
      }))
    } catch {
      // Keep whatever is cached; the next navigation retries.
    } finally {
      set((state) => ({
        listLoadingByProject: { ...state.listLoadingByProject, [projectId]: false },
      }))
    }
  },

  reorderSessions: async (projectId, orderedIds) => {
    const orderMap = new Map(orderedIds.map((id, index) => [id, index]))
    set((state) => {
      const sessions = [...(state.sessionsByProject[projectId] || [])].sort(
        (a, b) =>
          (orderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER)
          - (orderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER),
      )
      return {
        sessionsByProject: { ...state.sessionsByProject, [projectId]: pinChannelSessions(sessions) },
      }
    })
    try {
      await chatSessionApi.reorder(projectId, orderedIds)
    } catch {
      await get().fetchSessions(projectId)
    }
  },

  addSession: (session) =>
    set((state) => {
      const projectSessions = state.sessionsByProject[session.project_id] || []
      return {
        sessionsByProject: {
          ...state.sessionsByProject,
          [session.project_id]: pinChannelSessions([
            session,
            ...projectSessions.filter((item) => item.id !== session.id),
          ]),
        },
      }
    }),

  removeSession: (sessionId) =>
    set((state) => {
      const selectedIds = new Set(state.selectedIds)
      selectedIds.delete(sessionId)
      const sessionsByProject = Object.fromEntries(
        Object.entries(state.sessionsByProject).map(([projectId, sessions]) => [
          projectId,
          sessions.filter((item) => item.id !== sessionId),
        ]),
      )
      return {
        sessionsByProject,
        selectedIds,
        selectionProjectId: selectedIds.size === 0 ? null : state.selectionProjectId,
        selectAnchor: state.selectAnchor === sessionId ? null : state.selectAnchor,
      }
    }),

  renameSession: (sessionId, title) =>
    set((state) => {
      const sessionsByProject = Object.fromEntries(
        Object.entries(state.sessionsByProject).map(([projectId, sessions]) => [
          projectId,
          sessions.map((item) => item.id === sessionId ? { ...item, title } : item),
        ]),
      )
      return { sessionsByProject }
    }),

  // ── Multi-select logic ──

  handleSelect: (id, opts, projectId) => {
    const { sessionsByProject, selectedIds, selectionProjectId, selectAnchor } = get()
    const scopedProjectId = projectId || selectionProjectId
    const sessions = scopedProjectId ? (sessionsByProject[scopedProjectId] || []) : []
    const baseSelectedIds = scopedProjectId && selectionProjectId === scopedProjectId
      ? selectedIds
      : new Set<string>()
    const baseAnchor = scopedProjectId && selectionProjectId === scopedProjectId ? selectAnchor : null

    if (opts.shift && baseAnchor) {
      // Range select from anchor to clicked item
      const ids = sessions.map((s) => s.id)
      const anchorIdx = ids.indexOf(baseAnchor)
      const clickIdx = ids.indexOf(id)
      if (anchorIdx !== -1 && clickIdx !== -1) {
        const [start, end] = anchorIdx < clickIdx ? [anchorIdx, clickIdx] : [clickIdx, anchorIdx]
        const rangeIds = ids.slice(start, end + 1)
        // Union with existing non-range selections
        const next = new Set(baseSelectedIds)
        for (const rid of rangeIds) next.add(rid)
        set({ selectedIds: next, selectionProjectId: scopedProjectId || null, selectAnchor: id })
        return
      }
    }

    if (opts.meta) {
      // Cmd/Ctrl+Click → toggle individual
      const next = new Set(baseSelectedIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      set({
        selectedIds: next,
        selectionProjectId: next.size > 0 ? scopedProjectId || null : null,
        selectAnchor: id,
      })
      return
    }

    // Plain click → single select (replace)
    if (baseSelectedIds.size > 1 && baseSelectedIds.has(id)) {
      // Clicking an already-selected item when multi-select is active → deselect all
      set({ selectedIds: new Set(), selectionProjectId: null, selectAnchor: null })
    } else {
      set({ selectedIds: new Set([id]), selectionProjectId: scopedProjectId || null, selectAnchor: id })
    }
  },

  clearSelection: () => set({ selectedIds: new Set(), selectionProjectId: null, selectAnchor: null }),

  bulkRemove: async (projectId) => {
    const { selectedIds, bulkDeleting } = get()
    if (selectedIds.size === 0 || bulkDeleting) return { deleted: 0, skipped: 0 }
    const ids = [...selectedIds]
    set({ bulkDeleting: true })
    try {
      const result = await chatSessionApi.bulkDelete(projectId, ids)
      // Remove deleted sessions from local state
      const deletedSet = new Set(result.deleted)
      set((state) => ({
        sessionsByProject: Object.fromEntries(
          Object.entries(state.sessionsByProject).map(([projectId, sessions]) => [
            projectId,
            sessions.filter((item) => !deletedSet.has(item.id)),
          ]),
        ),
        selectedIds: new Set(),
        selectionProjectId: null,
        selectAnchor: null,
      }))
      // Also reset assistant store for deleted sessions
      for (const sid of result.deleted) {
        useChatSessionStore.getState().resetSession(sid)
      }
      return { deleted: result.deleted.length, skipped: result.skipped.length }
    } catch {
      set({ selectedIds: new Set(), selectionProjectId: null, selectAnchor: null })
      return { deleted: 0, skipped: 0 }
    } finally {
      set({ bulkDeleting: false })
    }
  },

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
