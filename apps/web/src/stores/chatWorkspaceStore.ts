import { create } from 'zustand'
import { appearanceCache, appearanceStorageKey } from '../utils/appearanceStorage'

export type ChatWorkspaceLayout = 'horizontal' | 'vertical'
export interface ChatWorkspacePane { id: string; projectId: string; sessionId: string | null }
export type ChatPaneSizes = Partial<Record<ChatWorkspaceLayout, { scope: string; values: number[] }>>
export interface ChatWorkspaceSnapshot {
  panes: ChatWorkspacePane[]
  layout: ChatWorkspaceLayout
  sizes: ChatPaneSizes
}

function readSnapshot(scope: string): ChatWorkspaceSnapshot | undefined {
  try {
    const saved = JSON.parse(appearanceCache.getItem(`${scope}:v1`) || 'null')
    if (!saved || !Array.isArray(saved.panes) || !saved.panes.length || saved.panes.length > 4
      || !['horizontal', 'vertical'].includes(saved.layout)) return undefined
    const ids = new Set<string>()
    for (const pane of saved.panes) {
      if (!pane || typeof pane.id !== 'string' || !pane.id || ids.has(pane.id)
        || typeof pane.projectId !== 'string' || !pane.projectId
        || !(pane.sessionId === null || typeof pane.sessionId === 'string')) return undefined
      ids.add(pane.id)
    }
    const sizes: ChatPaneSizes = {}
    for (const layout of ['horizontal', 'vertical'] as const) {
      const size = saved.sizes?.[layout]
      if (size && typeof size.scope === 'string' && Array.isArray(size.values)
        && size.values.length === saved.panes.length
        && size.values.every((value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0)) {
        sizes[layout] = { scope: size.scope, values: size.values }
      }
    }
    return { panes: saved.panes, layout: saved.layout, sizes }
  } catch { return undefined }
}

/** Account/device-scoped pane metadata survives navigation and page reloads; no chat content is copied. */
export const useChatWorkspaceStore = create<{
  workspaces: Record<string, ChatWorkspaceSnapshot>
  removal: { scope: string; panes: ChatWorkspacePane[] } | null
  removeSessions: (projectId: string, sessionIds: string[]) => boolean
  restore: (scope: string) => ChatWorkspaceSnapshot | undefined
  save: (scope: string, snapshot: ChatWorkspaceSnapshot) => void
}>((set, get) => ({
  workspaces: {},
  removal: null,
  removeSessions: (projectId, sessionIds) => {
    const scope = appearanceStorageKey('chat-workspace')
    const snapshot = get().restore(scope)
    if (!snapshot) return false
    const ids = new Set(sessionIds)
    const panes = snapshot.panes.filter(pane => pane.projectId !== projectId || !pane.sessionId || !ids.has(pane.sessionId))
    if (panes.length === snapshot.panes.length) return false
    if (!panes.length) panes.push({ ...snapshot.panes[0], sessionId: null })
    const next = { ...snapshot, panes, sizes: {} }
    appearanceCache.setItem(`${scope}:v1`, JSON.stringify(next))
    set(state => ({ workspaces: { ...state.workspaces, [scope]: next }, removal: { scope, panes } }))
    return true
  },
  restore: scope => get().workspaces[scope] ?? readSnapshot(scope),
  save: (scope, snapshot) => {
    appearanceCache.setItem(`${scope}:v1`, JSON.stringify(snapshot))
    set(state => ({ workspaces: { ...state.workspaces, [scope]: snapshot } }))
  },
}))
