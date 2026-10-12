import { gatewayRemotePortalUrl } from '../utils/gatewayRemote'
import { useEffect } from 'react'
import { create } from 'zustand'
import { gatewayFetch } from '../utils/gatewayWorkspacePath'
import { useUserSettingsStore } from './userSettingsStore'

export type GatewayConnection = {
  url: string; enabled: boolean; authenticated: boolean; online: boolean
  pending_device: boolean; package_locked: boolean; authorization_required?: boolean
  reconnecting?: boolean
}

let request: Promise<GatewayConnection> | null = null
let consumers = 0
let generation = 0

export const useGatewayConnectionStore = create<{
  status: GatewayConnection | null
  error: boolean
  refresh: () => Promise<GatewayConnection>
}>((set) => ({
  status: null, error: false,
  refresh: () => {
    const portal = gatewayRemotePortalUrl()
    if (portal) {
      // Remote pages display their gateway origin, never the device's private
      // connection configuration. Live tunnel status belongs to the outer frame.
      const status: GatewayConnection = { url: new URL(portal).origin, enabled: true,
        authenticated: true, online: true, pending_device: false, package_locked: true }
      set({ status, error: false })
      return Promise.resolve(status)
    }
    if (request) return request
    const current = generation
    request = gatewayFetch('/api/gateway-platform/settings').then(async response => {
      if (!response.ok) throw Error('Gateway status unavailable')
      const data = await response.json() as GatewayConnection
      if (current === generation) {
        const previous = useGatewayConnectionStore.getState().status
        set({ status: data, error: false })
        if (previous && previous.authenticated !== data.authenticated) void useUserSettingsStore.getState().load(true)
      }
      return data
    }).catch(error => {
      if (current === generation) set({ error: true })
      throw error
    }).finally(() => { if (current === generation) request = null })
    return request
  },
}))

export function useGatewayConnection() {
  const status = useGatewayConnectionStore(state => state.status)
  const error = useGatewayConnectionStore(state => state.error)
  useEffect(() => {
    consumers++
    const refresh = () => {
      if (document.visibilityState !== 'hidden') void useGatewayConnectionStore.getState().refresh().catch(() => undefined)
    }
    if (consumers === 1 && (gatewayRemotePortalUrl() || !useGatewayConnectionStore.getState().status || useGatewayConnectionStore.getState().error)) refresh()
    window.addEventListener('workstep:gateway-connection-changed', refresh)
    window.addEventListener('workstep:reconnected', refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      consumers--
      window.removeEventListener('workstep:gateway-connection-changed', refresh)
      window.removeEventListener('workstep:reconnected', refresh)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      if (!consumers) {
        generation++; request = null
        useGatewayConnectionStore.setState({ status: null, error: false })
      }
    }
  }, [])
  return { status, error }
}

export function gatewayConnectionState(status: GatewayConnection) {
  if (!status.enabled) return 'disabled'
  if (status.pending_device) return 'pending'
  if (status.authorization_required) return 'notAuthenticated'
  if (status.reconnecting) return 'connecting'
  if (!status.authenticated) return 'notAuthenticated'
  return status.online ? 'online' : 'connecting'
}
