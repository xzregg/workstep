import { DEFAULT_MESSAGE_HISTORY_PAGE_SIZE, validMessageHistoryPageSize } from '../utils/messageHistory'
import { create } from 'zustand'
import { systemSettingsApi } from '../api/client'
import { loadBrowserActor, saveBrowserActor } from '../utils/browserActor'

interface UserSettingsState {
  messageHistoryPageSize: number
  saveMessageHistoryPageSize: (size: number) => Promise<void>
  gitScanDepth: number
  saveGitScanDepth: (depth: number) => Promise<void>
  userName: string
  identitySource: 'local' | 'gateway'
  gatewayUsername: string
  openMode: boolean
  defaultProjectDirectory: string
  restrictFileAccessRoot: boolean
  saveDefaultProjectDirectory: (directory: string, restrictFileAccessRoot?: boolean) => Promise<void>
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
  messageHistoryPageSize: DEFAULT_MESSAGE_HISTORY_PAGE_SIZE,
  saveMessageHistoryPageSize: async (size) => {
    if (!validMessageHistoryPageSize(size)) throw new Error('请输入 1–300 之间的整数')
    const settings = await systemSettingsApi.updateMessageHistoryPageSize(size)
    if (settings.message_history_page_size !== size) throw new Error('消息加载设置未保存，请重试。')
    set({ messageHistoryPageSize: size })
  },
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
  restrictFileAccessRoot: true,
  saveDefaultProjectDirectory: async (directory, restrictFileAccessRoot) => {
    const settings = await systemSettingsApi.updateDefaultProjectDirectory(directory.trim(), restrictFileAccessRoot)
    if (restrictFileAccessRoot !== undefined && settings.restrict_file_access_root !== restrictFileAccessRoot) {
      throw new Error('文件访问限制未保存，请更新并重启后台服务后重试。')
    }
    set({ defaultProjectDirectory: settings.default_project_directory || '', restrictFileAccessRoot: settings.restrict_file_access_root ?? true })
  },
  deviceId: '',
  deviceName: '',
  loaded: false,
  loading: false,
  error: '',
  load: async (force = false) => {
    if ((get().loaded && !get().error && !force) || get().loading) return
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
        restrictFileAccessRoot: settings.restrict_file_access_root ?? true,
        gitScanDepth: settings.git_scan_depth ?? 5,
        messageHistoryPageSize: validMessageHistoryPageSize(settings.message_history_page_size)
          ? settings.message_history_page_size : DEFAULT_MESSAGE_HISTORY_PAGE_SIZE,
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

/** Read at request time so changing settings does not reload an open conversation. */
export function getMessageHistoryPageSize(): number {
  return useUserSettingsStore.getState().messageHistoryPageSize
}

/** Wait for the shared startup load before selecting the first page size. */
export async function loadMessageHistoryPageSize(): Promise<number> {
  if (!useUserSettingsStore.getState().loaded && !useUserSettingsStore.getState().loading) {
    await useUserSettingsStore.getState().load()
  }
  if (useUserSettingsStore.getState().loading) {
    await new Promise<void>(resolve => {
      const unsubscribe = useUserSettingsStore.subscribe(state => {
        if (!state.loading) { unsubscribe(); resolve() }
      })
    })
  }
  return getMessageHistoryPageSize()
}
