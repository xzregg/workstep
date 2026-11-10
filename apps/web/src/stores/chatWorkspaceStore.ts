import { create } from 'zustand'
import { chatSessionApi } from '../api/client'
import { useChatListStore } from './chatSessionStore'
import { useRecentVisitsStore } from './recentVisitsStore'
import { useProjectStore } from './projectStore'
import { useGatewaySessionStore } from './gatewaySessionStore'
import { resolveProjectPermissions } from '../utils/projectPermissions'
import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'
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
  removeSessions: (projectId: string, sessionIds: string[]) => Promise<boolean>
  restore: (scope: string) => ChatWorkspaceSnapshot | undefined
  save: (scope: string, snapshot: ChatWorkspaceSnapshot) => void
}>((set, get) => ({
  workspaces: {},
  removal: null,
  removeSessions: async (projectId, sessionIds) => {
    const scope = appearanceStorageKey('chat-workspace')
    const snapshot = get().restore(scope)
    if (!snapshot) return false
    const ids = new Set(sessionIds)
    const affected = (pane: ChatWorkspacePane) => pane.projectId === projectId && !!pane.sessionId && ids.has(pane.sessionId)
    if (!snapshot.panes.some(affected)) return false
    const canRead = (id: string) => useProjectStore.getState().projects.some(project => project.id === id)
      && resolveProjectPermissions(isGatewayRemoteBrowser(), useGatewaySessionStore.getState().session, id).can('session.read')
    const available = Object.entries(useChatListStore.getState().sessionsByProject).flatMap(([owner, sessions]) =>
      canRead(owner) ? sessions.filter(session => !session.archived && !(owner === projectId && ids.has(session.id)))
        .map(session => ({ projectId: owner, sessionId: session.id })) : [])
    const recent = useRecentVisitsStore.getState().entries
      .filter(entry => entry.kind === 'session' && canRead(entry.projectId)
        && !(entry.projectId === projectId && ids.has(entry.id)))
      .map(entry => ({ projectId: entry.projectId, sessionId: entry.id }))
    const panes = snapshot.panes.map(pane => affected(pane) ? { ...pane, sessionId: null } : pane)
    const publish = () => {
      const next = { ...snapshot, panes: [...panes] }
      appearanceCache.setItem(`${scope}:v1`, JSON.stringify(next))
      set(state => ({ workspaces: { ...state.workspaces, [scope]: next }, removal: { scope, panes: next.panes } }))
    }
    for (let index = 0; index < panes.length; index++) {
      if (!affected(snapshot.panes[index])) continue
      const unopened = (candidate: { projectId: string; sessionId: string }) =>
        !panes.some(pane => pane.projectId === candidate.projectId && pane.sessionId === candidate.sessionId)
      const replacement = recent.find(unopened) || available.find(unopened)
        || panes.find(pane => pane.sessionId && canRead(pane.projectId)) || available[0] || recent[0]
      if (replacement) panes[index] = { ...panes[index], projectId: replacement.projectId, sessionId: replacement.sessionId }
    }
    publish()
    const empty = panes.find(pane => !pane.sessionId)
    if (empty && !panes.some(pane => pane.sessionId)
      && resolveProjectPermissions(isGatewayRemoteBrowser(), useGatewaySessionStore.getState().session, empty.projectId).can('session.create')) {
      // Persist the empty windows first: creation failure must never restore removed conversations.
      const detail = await chatSessionApi.create({ project_id: empty.projectId }).catch(() => null)
      // Removal already succeeded; the empty pane retains its explicit create/retry action.
      if (!detail) return true
      useChatListStore.getState().addSession(detail)
      const current = get().restore(scope)
      if (current) {
        const nextPanes = current.panes.map(pane => panes.some(original => original.id === pane.id) && !pane.sessionId
          ? { ...pane, projectId: detail.project_id, sessionId: detail.id } : pane)
        get().save(scope, { ...current, panes: nextPanes })
        set({ removal: { scope, panes: nextPanes } })
      }
    }
    return true
  },
  restore: scope => get().workspaces[scope] ?? readSnapshot(scope),
  save: (scope, snapshot) => {
    appearanceCache.setItem(`${scope}:v1`, JSON.stringify(snapshot))
    set(state => ({ workspaces: { ...state.workspaces, [scope]: snapshot } }))
  },
}))
