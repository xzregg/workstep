import { create } from 'zustand'
import { systemSettingsApi } from '../api/client'

interface UserSettingsState {
  userName: string
  openMode: boolean
  defaultProjectDirectory: string
  saveDefaultProjectDirectory: (directory: string) => Promise<void>
  deviceId: string
  deviceName: string
  loaded: boolean
  loading: boolean
  error: string
  load: () => Promise<void>
  saveUserName: (name: string) => Promise<boolean>
  saveOpenMode: (enabled: boolean) => Promise<boolean>
}

export const useUserSettingsStore = create<UserSettingsState>((set, get) => ({
  userName: '',
  openMode: false,
  defaultProjectDirectory: '',
  saveDefaultProjectDirectory: async (directory) => {
    const settings = await systemSettingsApi.updateDefaultProjectDirectory(directory.trim())
    set({ defaultProjectDirectory: settings.default_project_directory || '' })
  },
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
      set({ defaultProjectDirectory: settings.default_project_directory || '' })
      set({ userName: settings.user_name, openMode: settings.open_mode, deviceId: settings.device_id || '', deviceName: settings.device_name || '', loaded: true })
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
      set({ userName: settings.user_name, openMode: settings.open_mode, deviceId: settings.device_id || '', deviceName: settings.device_name || '', loaded: true })
      return true
    } catch (reason) {
      set({ error: reason instanceof Error ? reason.message : String(reason) })
      return false
    } finally {
      set({ loading: false })
    }
  },
  saveOpenMode: async (enabled) => {
    set({ loading: true, error: '' })
    try {
      const settings = await systemSettingsApi.updateOpenMode(enabled)
      set({ openMode: settings.open_mode, loaded: true })
      return true
    } catch (reason) {
      set({ error: reason instanceof Error ? reason.message : String(reason) })
      return false
    } finally {
      set({ loading: false })
    }
  },
}))
