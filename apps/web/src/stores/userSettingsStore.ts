import { create } from 'zustand'
import { systemSettingsApi } from '../api/client'
import { loadBrowserActor, saveBrowserActor } from '../utils/browserActor'

interface UserSettingsState {
  gitScanDepth: number
  saveGitScanDepth: (depth: number) => Promise<void>
  userName: string
  identitySource: 'local' | 'gateway'
  gatewayUsername: string
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
  identitySource: 'local',
  gatewayUsername: '',
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
      let settings = await systemSettingsApi.get()
      let restoredActor = actor
      const gatewayIdentity = settings.identity_source === 'gateway'
      if (!gatewayIdentity && typeof window !== 'undefined' && window.workstepDesktop) {
        // Desktop ports can change across launches; config belongs to the
        // active native/sandbox Home, unlike origin-scoped browser storage.
        if (!settings.user_name && actor?.name) settings = await systemSettingsApi.updateUserName(actor.name)
        if (settings.user_name) restoredActor = saveBrowserActor(settings.user_name, {
          id: settings.device_id, deviceId: settings.device_id, deviceName: settings.device_name,
        })
      }
      set({
        defaultProjectDirectory: settings.default_project_directory || '',
        gitScanDepth: settings.git_scan_depth ?? 5,
        userName: gatewayIdentity ? settings.user_name : restoredActor?.name || '',
        identitySource: gatewayIdentity ? 'gateway' : 'local',
        gatewayUsername: settings.gateway_username || '',
        openMode: settings.open_mode,
        deviceId: restoredActor?.deviceId || '',
        deviceName: restoredActor?.deviceName || '',
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
    if (get().identitySource === 'gateway') return false
    const userName = name.trim()
    if (!userName) return false
    set({ loading: true, error: '' })
    try {
      const settings = typeof window !== 'undefined' && window.workstepDesktop
        ? await systemSettingsApi.updateUserName(userName) : null
      const next = saveBrowserActor(settings?.user_name || userName, {
        id: settings?.device_id, deviceId: settings?.device_id || get().deviceId,
        deviceName: settings?.device_name || get().deviceName,
      })
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
