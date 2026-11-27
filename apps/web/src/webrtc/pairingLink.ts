import { webrtcDeviceIdFromPath } from './webrtcLocation'

export const PAIR_KEY_MIN_LENGTH = 24
export const PAIR_KEY_MAX_LENGTH = 128
const STORAGE_PREFIX = 'workstep-webrtc-pair-key:'
let incoming: { deviceId: string; key: string } | null = null

export function validWebRtcPairKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{24,128}$/.test(value)
}

export function buildWebRtcPairingLink(entry: string, key: string): string {
  if (!validWebRtcPairKey(key)) return ''
  try {
    const url = new URL(entry)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || url.search || !/^\/p2p\/[^/]+\/?$/.test(url.pathname)) return ''
    url.hash = new URLSearchParams({ pair_key: key }).toString()
    return url.toString()
  } catch { return '' }
}

/** Remove the credential from browser history before diagnostics or navigation starts. */
export function consumeWebRtcPairingLink(): void {
  if (typeof window === 'undefined') return
  const deviceId = webrtcDeviceIdFromPath()
  if (!deviceId) return
  const params = new URLSearchParams(window.location.hash.slice(1))
  if (!params.has('pair_key')) return
  const values = params.getAll('pair_key')
  params.delete('pair_key')
  const remaining = params.toString()
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + (remaining ? `#${remaining}` : ''))
  incoming = values.length === 1 && validWebRtcPairKey(values[0]) ? { deviceId, key: values[0] } : null
}

export function loadSessionPairKey(deviceId: string): string {
  if (incoming?.deviceId === deviceId) return incoming.key
  if (!deviceId) return ''
  try {
    if (typeof sessionStorage === 'undefined') return ''
    const key = sessionStorage.getItem(STORAGE_PREFIX + deviceId) ?? ''
    return validWebRtcPairKey(key) ? key : ''
  } catch { return '' }
}

export function saveSessionPairKey(deviceId: string, key: string): void {
  if (!deviceId) return
  incoming = validWebRtcPairKey(key) ? { deviceId, key } : null
  try {
    if (typeof sessionStorage === 'undefined') return
    if (validWebRtcPairKey(key)) sessionStorage.setItem(STORAGE_PREFIX + deviceId, key)
    else sessionStorage.removeItem(STORAGE_PREFIX + deviceId)
  } catch { /* The current connection can still work when storage is blocked. */ }
}
