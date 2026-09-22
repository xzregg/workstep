import { create } from 'zustand'
import { systemSettingsApi } from '../api/client'
import { loadBrowserActor, saveBrowserActor } from '../utils/browserActor'

interface UserSettingsState {
  gitScanDepth: number
  saveGitScanDepth: (depth: number) => Promise<void>
  userName: string
  openMode: boolean
  defaultProjectDirectory: string
  saveDefaultProjectDirectory: (directory: string) => Promise<void>
  deviceId: string
  deviceName: string
  loaded: boolean
  loading: boolean
  error: string
  load: (force?: boolean) => Promise<void>
  saveUserName: (name: string) => Promise<boolean>
  saveOpenMode: (enabled: boolean) => Promise<boolean>
}

export const useUserSettingsStore = create<UserSettingsState>((set, get) => ({
  gitScanDepth: 5,
  saveGitScanDepth: async (depth) => {
    const settings = await systemSettingsApi.updateGitScanDepth(depth)
    if (settings.git_scan_depth !== depth) throw new Error('Git 扫描设置未保存，请检查后台服务版本后重试。')
    set({ gitScanDepth: settings.git_scan_depth })
  },
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
  load: async (force = false) => {
    if ((get().loaded && !force) || get().loading) return
    set({ loading: true, error: '' })
    const actor = loadBrowserActor()
    try {
      const settings = await systemSettingsApi.get()
      set({
        defaultProjectDirectory: settings.default_project_directory || '',
        gitScanDepth: settings.git_scan_depth ?? 5,
        userName: actor?.name || '',
        openMode: settings.open_mode,
        deviceId: actor?.deviceId || '',
        deviceName: actor?.deviceName || '',
        loaded: true,
      })
    } catch (reason) {
      set({
        userName: actor?.name || '',
        deviceId: actor?.deviceId || '',
        deviceName: actor?.deviceName || '',
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
      const next = saveBrowserActor(userName, { deviceId: get().deviceId, deviceName: get().deviceName })
      if (!next) throw new Error('无法保存浏览器身份')
      set({ userName: next.name, deviceId: next.deviceId, deviceName: next.deviceName, loaded: true })
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
