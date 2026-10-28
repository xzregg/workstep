import { create } from 'zustand'

export type ChatWorkspaceLayout = 'horizontal' | 'vertical'
export interface ChatWorkspacePane { id: string; projectId: string; sessionId: string | null }
export type ChatPaneSizes = Partial<Record<ChatWorkspaceLayout, { scope: string; values: number[] }>>
export interface ChatWorkspaceSnapshot {
  panes: ChatWorkspacePane[]
  layout: ChatWorkspaceLayout
  sizes: ChatPaneSizes
}

/** Navigation-only snapshots, scoped to the current account/device; no chat content is copied. */
export const useChatWorkspaceStore = create<{
  workspaces: Record<string, ChatWorkspaceSnapshot>
  save: (scope: string, snapshot: ChatWorkspaceSnapshot) => void
}>(set => ({
  workspaces: {},
  save: (scope, snapshot) => set(state => ({ workspaces: { ...state.workspaces, [scope]: snapshot } })),
}))
