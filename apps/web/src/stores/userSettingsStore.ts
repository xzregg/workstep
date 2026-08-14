import { create } from 'zustand'
import { systemSettingsApi } from '../api/client'

interface UserSettingsState {
  userName: string
  deviceId: string
  deviceName: string
  loaded: boolean
  loading: boolean
  error: string
  load: () => Promise<void>
  saveUserName: (name: string) => Promise<boolean>
}

export const useUserSettingsStore = create<UserSettingsState>((set, get) => ({
  userName: '',
  deviceId: '',
  deviceName: '',
  loaded: false,
  loading: false,
  error: '',
  load: async () => {
    if (get().loaded || get().loading) return
    set({ loading: true, error: '' })
    try {
      const settings = await systemSettingsApi.get()
      set({ userName: settings.user_name, deviceId: settings.device_id || '', deviceName: settings.device_name || '', loaded: true })
    } catch (reason) {
      set({
        loaded: true,
        error: reason instanceof Error ? reason.message : String(reason),
      })
    } finally {
      set({ loading: false })
    }
  },
  saveUserName: async (name) => {
    const userName = name.trim()
    if (!userName) return false
    set({ loading: true, error: '' })
    try {
      const settings = await systemSettingsApi.updateUserName(userName)
      set({ userName: settings.user_name, deviceId: settings.device_id || '', deviceName: settings.device_name || '', loaded: true })
      return true
    } catch (reason) {
      set({ error: reason instanceof Error ? reason.message : String(reason) })
      return false
    } finally {
      set({ loading: false })
    }
  },
}))
