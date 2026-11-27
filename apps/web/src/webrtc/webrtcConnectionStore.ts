import { create } from 'zustand'

export interface WebRtcConnectionState {
  connected: boolean
  reconnecting: boolean
  latencyMs: number | null
  deviceName: string
}

export const useWebRtcConnectionStore = create<WebRtcConnectionState>(() => ({
  connected: false,
  reconnecting: false,
  latencyMs: null,
  deviceName: '',
}))

export function formatLatencyDisplay(latencyMs: number | null): {
  valid: boolean
  value: number | null
  suffix: string
  modifierClass: string
} {
  if (latencyMs === null || !Number.isFinite(latencyMs) || latencyMs < 0) {
    return { valid: false, value: null, suffix: '', modifierClass: '' }
  }
  const value = Math.round(latencyMs)
  const modifierClass = value > 1000
    ? ' gateway-connection-latency--slow'
    : value >= 500
      ? ' gateway-connection-latency--warning'
      : ''
  return { valid: true, value, suffix: ` · ${value} ms`, modifierClass }
}
