/**
 * Browser WebRTC peer lifecycle: pairs via signaling + STUN, enforces direct-only
 * non-relay candidate pairs, and establishes the multiplexed DataChannel.
 */

import { isWebRtcRemoteBrowser } from './webrtcLocation'
import {
  WEBRTC_PROXY_CHANNEL_LABEL,
  WebRtcTransportClient,
  verifyNonRelayCandidatePair,
  type DirectCandidateInfo,
} from './transportAdapter'

export const ICE_DISCONNECT_GRACE_MS = 4000

export interface WebRtcConfigSummary {
  online: boolean
  device_id: string
  device_name: string
  stun_urls: string[]
  direct_only: boolean
  session_authorized?: boolean
}

export interface WebRtcConnectionHandle {
  deviceId: string
  deviceName: string
  candidateInfo: DirectCandidateInfo
  transport: WebRtcTransportClient
  peerConnection: RTCPeerConnection
  close: () => void
  waitClosed: Promise<string>
}

export async function fetchWebRtcDeviceConfig(deviceId: string): Promise<WebRtcConfigSummary> {
  const response = await fetch(`/api/webrtc/config?device_id=${encodeURIComponent(deviceId)}`, {
    credentials: 'same-origin',
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return await response.json() as WebRtcConfigSummary
}

export async function connectWebRtcDirect(options: {
  deviceId: string
  pairKey: string
  signal?: AbortSignal
}): Promise<WebRtcConnectionHandle> {
  const { deviceId, pairKey, signal } = options
  const pairResponse = await fetch('/api/webrtc/pair', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId, pair_key: pairKey }),
    signal,
  })
  if (!pairResponse.ok) {
    const errBody = await pairResponse.json().catch(() => ({}))
    throw new Error(String((errBody as { detail?: string }).detail || `Pairing failed (${pairResponse.status})`))
  }
  const pairData = await pairResponse.json() as {
    session_id: string
    session_token: string
    p2p_ticket: string
    device_name: string
    stun_urls: string[]
  }

  // Strictly forbid TURN servers; pure STUN + host direct candidates only.
  const stunUrls = (pairData.stun_urls || []).filter((url) => url.toLowerCase().startsWith('stun:'))
  const pc = new RTCPeerConnection({
    iceServers: stunUrls.length ? stunUrls.map((urls) => ({ urls })) : [],
    iceTransportPolicy: 'all',
  })
  const channel = pc.createDataChannel(WEBRTC_PROXY_CHANNEL_LABEL, { ordered: true })

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${protocol}//${window.location.host}/ws/webrtc/client?device_id=${encodeURIComponent(deviceId)}&token=${encodeURIComponent(pairData.session_token)}`
  const sigWs = new WebSocket(wsUrl)

  let closed = false
  let disconnectTimer: number | null = null
  const clearDisconnectTimer = () => {
    if (disconnectTimer !== null) {
      window.clearTimeout(disconnectTimer)
      disconnectTimer = null
    }
  }
  let notifyClosed!: (reason: string) => void
  const waitClosed = new Promise<string>((resolve) => {
    notifyClosed = resolve
  })

  const cleanup = (reason = 'closed') => {
    clearDisconnectTimer()
    if (closed) return
    closed = true
    try { sigWs.close() } catch { /* ignore */ }
    try { channel.close() } catch { /* ignore */ }
    try { pc.close() } catch { /* ignore */ }
    notifyClosed(reason)
  }

  signal?.addEventListener('abort', () => cleanup('aborted'), { once: true })

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Signaling connection timed out')), 10000)
      sigWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as Record<string, unknown>
          if (msg.type === 'client_ready') {
            window.clearTimeout(timer)
            resolve()
          } else if (msg.type === 'error') {
            window.clearTimeout(timer)
            reject(new Error(String(msg.message || msg.code || 'Signaling error')))
          }
        } catch {
          /* ignore */
        }
      }
      sigWs.onerror = () => {
        window.clearTimeout(timer)
        reject(new Error('Signaling WebSocket error'))
      }
      sigWs.onclose = () => {
        window.clearTimeout(timer)
        reject(new Error('Signaling WebSocket closed'))
      }
    })

    const signalFailurePromise = new Promise<never>((_resolve, reject) => {
      sigWs.onmessage = (event) => {
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(String(event.data)) as Record<string, unknown>
        } catch {
          return
        }
        if (msg.type === 'answer' && typeof msg.sdp === 'string') {
          void pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(reject)
        } else if (msg.type === 'ice_candidate') {
          const cand = typeof msg.candidate === 'string' ? msg.candidate : ''
          if (/\btyp\s+relay\b/i.test(cand)) {
            reject(new Error('Relay candidate rejected in direct-only mode'))
            return
          }
          void pc.addIceCandidate(cand ? {
            candidate: cand,
            sdpMid: typeof msg.sdpMid === 'string' ? msg.sdpMid : '0',
            sdpMLineIndex: typeof msg.sdpMLineIndex === 'number' ? msg.sdpMLineIndex : 0,
          } : null).catch(() => undefined)
        } else if (msg.type === 'error') {
          reject(new Error(String(msg.message || msg.code || 'WebRTC signaling rejected')))
        }
      }
    })

    const channelOpenPromise = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('WebRTC direct connection timed out (NAT/firewall blocked direct UDP)')), 20000)
      channel.onopen = () => {
        window.clearTimeout(timeout)
        resolve()
      }
      channel.onerror = () => {
        window.clearTimeout(timeout)
        reject(new Error('WebRTC DataChannel failed'))
      }
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed') {
          window.clearTimeout(timeout)
          reject(new Error('ICE direct hole-punching failed (no non-relay path available)'))
        }
      }
    })

    let sentOffer = false
    const pendingCandidates: RTCIceCandidate[] = []
    pc.onicecandidate = (event) => {
      if (event.candidate?.candidate && /\btyp\s+relay\b/i.test(event.candidate.candidate)) {
        cleanup('relay_not_allowed')
        return
      }
      if (!sentOffer) {
        if (event.candidate) pendingCandidates.push(event.candidate)
        return
      }
      if (sigWs.readyState === WebSocket.OPEN) {
        sigWs.send(JSON.stringify({
          type: 'ice_candidate',
          candidate: event.candidate ? event.candidate.candidate : '',
          sdpMid: event.candidate?.sdpMid ?? '0',
          sdpMLineIndex: event.candidate?.sdpMLineIndex ?? 0,
        }))
      }
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    // Briefly allow local host + STUN srflx candidates to populate the initial offer SDP.
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve()
        return
      }
      const timer = window.setTimeout(resolve, 1200)
      const onGather = () => {
        if (pc.iceGatheringState === 'complete') {
          window.clearTimeout(timer)
          pc.removeEventListener('icegatheringstatechange', onGather)
          resolve()
        }
      }
      pc.addEventListener('icegatheringstatechange', onGather)
    })

    const localSdp = pc.localDescription?.sdp || offer.sdp || ''
    if (/\btyp\s+relay\b/i.test(localSdp)) {
      throw new Error('Relay candidate detected in local SDP')
    }
    sentOffer = true
    sigWs.send(JSON.stringify({ type: 'offer', sdp: localSdp }))
    for (const cand of pendingCandidates) {
      if (sigWs.readyState === WebSocket.OPEN) {
        sigWs.send(JSON.stringify({
          type: 'ice_candidate',
          candidate: cand.candidate,
          sdpMid: cand.sdpMid ?? '0',
          sdpMLineIndex: cand.sdpMLineIndex ?? 0,
        }))
      }
    }

    await Promise.race([channelOpenPromise, signalFailurePromise])

    // Enforce direct non-relay candidate pair check via browser getStats().
    let candidateInfo: DirectCandidateInfo | null = null
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const stats = await pc.getStats()
        candidateInfo = verifyNonRelayCandidatePair(stats)
        break
      } catch (err) {
        if (err instanceof Error && /relay/i.test(err.message)) {
          throw err
        }
        await new Promise((r) => window.setTimeout(r, 80))
      }
    }
    if (!candidateInfo) {
      throw new Error('Unable to verify direct non-relay ICE candidate pair')
    }

    const transport = new WebRtcTransportClient(channel)
    await transport.authenticate(pairData.p2p_ticket)

    // Signaling can be closed once the direct peer connection is authenticated.
    try { sigWs.close() } catch { /* ignore */ }

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState
      if (state === 'connected' || state === 'completed') {
        clearDisconnectTimer()
        return
      }
      if (state === 'disconnected') {
        if (disconnectTimer === null && !closed) {
          disconnectTimer = window.setTimeout(() => {
            disconnectTimer = null
            if (!closed && pc.iceConnectionState === 'disconnected') {
              transport.close()
              cleanup('disconnected')
            }
          }, ICE_DISCONNECT_GRACE_MS)
        }
        return
      }
      if (state === 'failed' || state === 'closed') {
        transport.close()
        cleanup(state)
      }
    }
    channel.onclose = () => {
      transport.close()
      cleanup('channel_closed')
    }

    return {
      deviceId,
      deviceName: pairData.device_name || deviceId,
      candidateInfo,
      transport,
      peerConnection: pc,
      close: () => {
        transport.close()
        cleanup('user_closed')
      },
      waitClosed,
    }
  } catch (err) {
    cleanup('error')
    throw err
  }
}

export function isWebRtcContextActive(): boolean {
  return isWebRtcRemoteBrowser()
}
