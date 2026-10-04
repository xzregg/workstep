import { create } from 'zustand'
import { request } from '../api/transport'

export interface GatewayRemoteSession {
  device_id: string
  device_name: string
  username: string
  gateway_url: string
  project_id: string | null
  host_project_id: string | null
  access_level: 'read' | 'edit' | null
  task_create: boolean
  share_create: boolean
  can_manage_project_access: boolean
}

interface GatewaySessionState {
  session: GatewayRemoteSession | null
  error: string
  loading: boolean
  load: (force?: boolean) => Promise<GatewayRemoteSession>
}

let pending: Promise<GatewayRemoteSession> | null = null
export const useGatewaySessionStore = create<GatewaySessionState>((set, get) => ({
  session: null, error: '', loading: false,
  load: (force = false) => {
    if (pending) return pending
    if (!force && get().session) return Promise.resolve(get().session!)
    set({ loading: true, error: '' })
    pending = request<GatewayRemoteSession>('/remote/session').then(session => {
      if (!session.device_id || !session.gateway_url ||
          (!!session.project_id !== !!session.host_project_id) ||
          (session.project_id && !['read', 'edit'].includes(session.access_level ?? ''))) {
        throw new Error('远程项目会话无效，请从平台重新打开。')
      }
      set({ session })
      return session
    }).catch(reason => {
      set({ session: null, error: reason instanceof Error ? reason.message : '远程会话已失效。' })
      throw reason
    }).finally(() => { pending = null; set({ loading: false }) })
    return pending
  },
}))
