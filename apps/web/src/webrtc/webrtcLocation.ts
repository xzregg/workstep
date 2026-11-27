/** Route detection helpers for `/p2p/<device_id>` direct WebRTC workspaces. */

export function webrtcWorkspacePath(): string {
  if (typeof window === 'undefined') return ''
  return window.location?.pathname?.match(/^\/p2p\/[^/]+(?=\/|$)/)?.[0] ?? ''
}

export function webrtcDeviceIdFromPath(): string {
  const prefix = webrtcWorkspacePath()
  if (!prefix) return ''
  const raw = prefix.slice('/p2p/'.length)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export function isWebRtcRemoteBrowser(): boolean {
  return webrtcWorkspacePath() !== ''
}
