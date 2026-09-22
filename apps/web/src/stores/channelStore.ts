import { create } from 'zustand'
import { channelApi, type ChannelInfo, type ChannelLoginResult } from '../api/client'

interface ChannelState {
  projectId: string | null
  channels: ChannelInfo[]
  login: ChannelLoginResult | null
  loading: boolean
  saving: boolean
  error: string
  load: (projectId: string) => Promise<void>
  update: (channelId: string, values: { enabled: boolean; assistantId: string; model: string }) => Promise<void>
  startLogin: () => Promise<void>
  refreshLogin: () => Promise<void>
  logout: () => Promise<void>
  handleWsEvent: (event: Record<string, unknown>) => void
}

let loadSequence = 0

export const useChannelStore = create<ChannelState>((set, get) => ({
  projectId: null,
  channels: [],
  login: null,
  loading: false,
  saving: false,
  error: '',

  load: async (projectId) => {
    if (get().loading && get().projectId === projectId) return
    const sequence = ++loadSequence
    const changedProject = get().projectId !== projectId
    set({
      projectId,
      loading: true,
      error: '',
      ...(changedProject ? { channels: [], login: null, saving: false } : {}),
    })
    try {
      const channels = await channelApi.list(projectId)
      if (get().projectId !== projectId || sequence !== loadSequence) return
      set({ channels, loading: false })
    } catch (reason) {
      if (get().projectId !== projectId || sequence !== loadSequence) return
      set({ loading: false, error: reason instanceof Error ? reason.message : String(reason) })
    }
  },

  update: async (channelId, values) => {
    const projectId = get().projectId
    if (!projectId) return
    set({ saving: true, error: '' })
    try {
      const channel = await channelApi.update(channelId, projectId, values)
      if (get().projectId !== projectId) return
      set((state) => ({
        channels: state.channels.map((item) => item.id === channel.id ? channel : item),
        saving: false,
      }))
    } catch (reason) {
      if (get().projectId !== projectId) return
      set({ saving: false, error: reason instanceof Error ? reason.message : String(reason) })
      throw reason
    }
  },

  startLogin: async () => {
    const projectId = get().projectId
    if (!projectId) return
    set({ saving: true, error: '' })
    try {
      const login = await channelApi.login(projectId)
      if (get().projectId === projectId) set({ login, saving: false })
    } catch (reason) {
      if (get().projectId !== projectId) return
      set({ saving: false, error: reason instanceof Error ? reason.message : String(reason) })
    }
  },

  refreshLogin: async () => {
    const projectId = get().projectId
    if (!projectId) return
    try {
      const login = await channelApi.loginStatus(projectId)
      if (get().projectId !== projectId) return
      set({ login })
      if (login.status === 'success') await get().load(projectId)
    } catch (reason) {
      if (get().projectId !== projectId) return
      set({ error: reason instanceof Error ? reason.message : String(reason) })
    }
  },

  logout: async () => {
    const projectId = get().projectId
    if (!projectId) return
    set({ saving: true, error: '' })
    try {
      await channelApi.logout(projectId)
      if (get().projectId !== projectId) return
      set({ login: null, saving: false })
      await get().load(projectId)
    } catch (reason) {
      set({ saving: false, error: reason instanceof Error ? reason.message : String(reason) })
    }
  },

  handleWsEvent: (event) => {
    const eventProjectId = typeof event.project_id === 'string' ? event.project_id : ''
    if (!eventProjectId || eventProjectId !== get().projectId) return
    if (event.type !== 'CUSTOM' || typeof event.name !== 'string') return
    if (!event.name.startsWith('channel.')) return
    const value = event.value && typeof event.value === 'object'
      ? event.value as Record<string, unknown>
      : {}
    if (event.name === 'channel.login_status' || event.name === 'channel.qr_code') {
      set({ login: {
        status: String(value.status || 'not_started') as ChannelLoginResult['status'],
        qr_code: typeof value.qr_code === 'string' ? value.qr_code : null,
        account_id: typeof value.account_id === 'string' ? value.account_id : null,
        error: typeof value.error === 'string' ? value.error : null,
      } })
      const projectId = get().projectId
      if (value.status === 'success' && projectId) void get().load(projectId)
    }
    if (event.name === 'channel.state') {
      const projectId = get().projectId
      if (projectId) void get().load(projectId)
    }
  },
}))
