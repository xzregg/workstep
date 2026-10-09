import { create } from 'zustand'
import { request } from '../api/transport'

interface ManagedModeState {
  canManageRemoteProjects: boolean
  managed: boolean | null
  loading: boolean
  load: () => Promise<void>
}

export const useManagedModeStore = create<ManagedModeState>((set, get) => ({
  canManageRemoteProjects: false,
  managed: null,
  loading: false,
  load: async () => {
    if (get().managed !== null || get().loading) return
    set({ loading: true })
    try {
      const result = await request<{ managed: boolean; can_manage_remote_projects?: boolean }>('/managed/mode')
      set({ managed: result.managed, canManageRemoteProjects: result.can_manage_remote_projects === true })
    } catch {
      set({ managed: null, canManageRemoteProjects: false })
    } finally {
      set({ loading: false })
    }
  },
}))
