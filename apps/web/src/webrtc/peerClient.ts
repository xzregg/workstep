/**
 * Browser WebRTC peer lifecycle: pairs via signaling + STUN, enforces direct-only
 * non-relay candidate pairs, and establishes the multiplexed DataChannel.
 */

import { isWebRtcRemoteBrowser } from './webrtcLocation'
import { validWebRtcPairKey } from './pairingLink'
import {
  WEBRTC_PROXY_CHANNEL_LABEL,
  WebRtcTransportClient,
  verifyNonRelayCandidatePair,
  type DirectCandidateInfo,
} from './transportAdapter'

export const ICE_DISCONNECT_GRACE_MS = 4000
import { ConnectionDiagnostics, WebRtcConnectionError, type ConnectionSnapshot, type WebRtcConnectionStage } from './connectionDiagnostics'
export { WEBRTC_CONNECTION_STAGES, type WebRtcConnectionStage, type WebRtcStageTiming } from './connectionDiagnostics'

export interface WebRtcConfigSummary {
  online: boolean
  device_id: string
  device_name: string
  stun_urls: string[]
  direct_only: boolean
  session_authorized?: boolean
  pair_key_salt: string
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

export async function fetchWebRtcDeviceConfig(deviceId: string, signal?: AbortSignal): Promise<WebRtcConfigSummary> {
  const response = await fetch(`/api/webrtc/config?device_id=${encodeURIComponent(deviceId)}`, {
    credentials: 'same-origin',
    signal,
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
  onStage?: (stage: WebRtcConnectionStage) => void
  onDiagnostics?: (snapshot: ConnectionSnapshot) => void
  onDeviceConfig?: (config: WebRtcConfigSummary) => void
}): Promise<WebRtcConnectionHandle> {
  const { deviceId, pairKey, signal, onStage, onDeviceConfig } = options
  if (!validWebRtcPairKey(pairKey)) throw new Error('Invalid device pairing key length or format')
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const signalingUrl = `${protocol}//${window.location.host}/ws/webrtc/client`
  const diagnostics = new ConnectionDiagnostics(signalingUrl, options.onDiagnostics, onStage)
  diagnostics.advance('configuration')
  const earlyFailure = (error: unknown): never => { const snapshot = diagnostics.snapshot(); diagnostics.stop(); throw new WebRtcConnectionError(error instanceof Error ? error.message : String(error), snapshot) }
  const config = await fetchWebRtcDeviceConfig(deviceId, signal).catch(earlyFailure)
  onDeviceConfig?.(config)
  if (!config.pair_key_salt) earlyFailure(new Error('Device pairing configuration unavailable'))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${config.pair_key_salt}:${pairKey}`))
  const proof = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
  diagnostics.advance('pairing')
  const pairResponse = await fetch('/api/webrtc/pair', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId, pair_proof: proof }),
    signal,
  }).catch(earlyFailure)
  if (!pairResponse.ok) {
    const errBody = await pairResponse.json().catch(() => ({}))
    earlyFailure(new Error(String((errBody as { detail?: string }).detail || `Pairing failed (${pairResponse.status})`)))
  }
  const pairData = await pairResponse.json().catch(earlyFailure) as {
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

  const wsUrl = `${protocol}//${window.location.host}/ws/webrtc/client?device_id=${encodeURIComponent(deviceId)}&token=${encodeURIComponent(pairData.session_token)}`
  diagnostics.attach(pc, channel)
  diagnostics.advance('signaling')
  const sigWs = new WebSocket(wsUrl)
  const diagnosticTimer = window.setInterval(() => { void diagnostics.sample() }, 500)
  const observeDiagnostics = () => diagnostics.observe()
  pc.onicegatheringstatechange = observeDiagnostics
  pc.onconnectionstatechange = observeDiagnostics
  pc.onicecandidateerror = event => diagnostics.stunError(event.url || '', event.errorCode || 0)
  const stopDiagnostics = () => { window.clearInterval(diagnosticTimer); diagnostics.stop(); pc.onicegatheringstatechange = null; pc.onconnectionstatechange = null; pc.onicecandidateerror = null; pc.sctp?.transport.removeEventListener('statechange', observeDiagnostics) }

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
    stopDiagnostics()
    try { sigWs.close() } catch { /* ignore */ }
    try { channel.close() } catch { /* ignore */ }
    try { pc.close() } catch { /* ignore */ }
    notifyClosed(reason)
  }

  signal?.addEventListener('abort', () => cleanup('aborted'), { once: true })

  try {
    await new Promise<void>((resolve, reject) => {
      sigWs.onopen = () => diagnostics.socketOpened()
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
        diagnostics.socketClosed()
        window.clearTimeout(timer)
        reject(new Error('Signaling WebSocket closed'))
      }
    })

    diagnostics.advance('exchange')
    const signalFailurePromise = new Promise<never>((_resolve, reject) => {
      sigWs.onerror = () => { if (diagnostics.snapshot().stage === 'exchange') reject(new Error('Signaling WebSocket error')) }
      sigWs.onclose = () => { diagnostics.socketClosed(); if (diagnostics.snapshot().stage === 'exchange') reject(new Error('Signaling WebSocket closed')) }
      let remoteDescriptionReady = Promise.resolve()
      sigWs.onmessage = (event) => {
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(String(event.data)) as Record<string, unknown>
        } catch {
          return
        }
        if (msg.type === 'answer' && typeof msg.sdp === 'string') {
          diagnostics.remoteSdp(msg.sdp)
          remoteDescriptionReady = pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
            .then(() => { if (!closed) { diagnostics.advance('ice'); diagnostics.observe() } }, reject)
        } else if (msg.type === 'ice_candidate') {
          const cand = typeof msg.candidate === 'string' ? msg.candidate : ''
          diagnostics.candidate('remote', cand)
          if (/\btyp\s+relay\b/i.test(cand)) {
            reject(new Error('Relay candidate rejected in direct-only mode'))
            return
          }
          remoteDescriptionReady = remoteDescriptionReady.then(() => pc.addIceCandidate(cand ? {
            candidate: cand,
            sdpMid: typeof msg.sdpMid === 'string' ? msg.sdpMid : undefined,
            sdpMLineIndex: typeof msg.sdpMLineIndex === 'number' ? msg.sdpMLineIndex : 0,
          } : undefined)).catch(() => undefined)
        } else if (msg.type === 'error') {
          reject(new Error(String(msg.message || msg.code || 'WebRTC signaling rejected')))
        }
      }
    })

    const channelOpenPromise = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('WebRTC direct connection timed out')), 20000)
      channel.onopen = () => {
        diagnostics.observe()
        diagnostics.advance('channel')
        window.clearTimeout(timeout)
        resolve()
      }
      channel.onerror = () => {
        window.clearTimeout(timeout)
        reject(new Error('WebRTC DataChannel failed'))
      }
      pc.oniceconnectionstatechange = () => {
        diagnostics.observe()
        if (pc.iceConnectionState === 'failed') {
          window.clearTimeout(timeout)
          reject(new Error('ICE direct hole-punching failed (no non-relay path available)'))
        }
      }
    })

    let sentOffer = false
    const pendingCandidates: (RTCIceCandidate | null)[] = []
    const sendCandidate = (candidate: RTCIceCandidate | null) => {
      if (sigWs.readyState !== WebSocket.OPEN) return
      sigWs.send(JSON.stringify({
        type: 'ice_candidate',
        candidate: candidate?.candidate || null,
        sdpMid: candidate?.sdpMid ?? '0',
        sdpMLineIndex: candidate?.sdpMLineIndex ?? 0,
      }))
    }
    pc.onicecandidate = (event) => {
      if (event.candidate?.candidate) diagnostics.candidate('local', event.candidate.candidate)
      diagnostics.observe()
      if (event.candidate?.candidate && /\btyp\s+relay\b/i.test(event.candidate.candidate)) {
        cleanup('relay_not_allowed')
        return
      }
      if (!sentOffer) {
        pendingCandidates.push(event.candidate)
        return
      }
      sendCandidate(event.candidate)
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    pc.sctp?.transport.addEventListener('statechange', observeDiagnostics)

    const localSdp = pc.localDescription?.sdp || offer.sdp || ''
    if (/\btyp\s+relay\b/i.test(localSdp)) {
      throw new Error('Relay candidate detected in local SDP')
    }
    sentOffer = true
    sigWs.send(JSON.stringify({ type: 'offer', sdp: localSdp, trickle_answer: true }))
    for (const candidate of pendingCandidates) sendCandidate(candidate)

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

    diagnostics.advance('authentication')
    const transport = new WebRtcTransportClient(channel)
    await transport.authenticate(pairData.p2p_ticket, pairKey)

    stopDiagnostics()
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
      cleanup('channel_closed')
      transport.close()
    }
    channel.onerror = () => {
      cleanup('channel_error')
      transport.close()
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
    diagnostics.observe()
    const snapshot = diagnostics.snapshot()
    cleanup('error')
    throw new WebRtcConnectionError(err instanceof Error ? err.message : String(err), snapshot)
  }
}

export function isWebRtcContextActive(): boolean {
  return isWebRtcRemoteBrowser()
}
