import { create } from 'zustand'
import { request } from '../api/transport'

interface ManagedModeState {
  managed: boolean | null
  loading: boolean
  load: () => Promise<void>
}

export const useManagedModeStore = create<ManagedModeState>((set, get) => ({
  managed: null,
  loading: false,
  load: async () => {
    if (get().managed !== null || get().loading) return
    set({ loading: true })
    try {
      const result = await request<{ managed: boolean }>('/managed/mode')
      set({ managed: result.managed })
    } catch {
      set({ managed: null })
    } finally {
      set({ loading: false })
    }
  },
}))
