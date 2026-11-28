/** Observable connection evidence shared by the tiny entry page and workbench. */
export const WEBRTC_CONNECTION_STAGES = ['configuration', 'pairing', 'signaling', 'exchange', 'ice', 'dtls', 'channel', 'authentication'] as const
export type WebRtcConnectionStage = typeof WEBRTC_CONNECTION_STAGES[number]
export type WebRtcStageTiming = { stage: WebRtcConnectionStage; durationMs: number }
type Counts = { host: number; srflx: number; prflx: number }
export interface ConnectionSnapshot {
  stage: WebRtcConnectionStage
  signalingUrl: string
  socketOpen: boolean
  socketState: string
  local: Counts
  remote: Counts
  gatheringState: string
  iceState: string
  dtlsState: string
  channelState: string
  probes: { sent: number; received: number; pairs: number }
  stunErrors: { server: string; code: number }[]
}
export type ConnectionFailure = 'configuration' | 'pairing' | 'signal_connect' | 'signal_ready' | 'signal_lost' | 'answer' | 'local_candidates' | 'remote_candidates' | 'ice_path' | 'dtls' | 'datachannel' | 'authentication'

export function classifyConnectionFailure(snapshot: ConnectionSnapshot): ConnectionFailure {
  const { stage } = snapshot
  if (stage === 'configuration' || stage === 'pairing' || stage === 'authentication') return stage
  if (stage === 'signaling') return snapshot.socketOpen ? 'signal_ready' : 'signal_connect'
  if (stage === 'exchange') return snapshot.socketState === 'closed' ? 'signal_lost' : 'answer'
  if (!Object.values(snapshot.local).some(Boolean)) return 'local_candidates'
  if (!Object.values(snapshot.remote).some(Boolean)) return 'remote_candidates'
  if (snapshot.iceState === 'failed') return 'ice_path'
  if (stage === 'dtls') return 'dtls'
  if (stage === 'channel') return 'datachannel'
  return 'ice_path'
}

export class WebRtcConnectionError extends Error {
  readonly diagnostics: ConnectionSnapshot
  constructor(message: string, diagnostics: ConnectionSnapshot) { super(message); this.name = 'WebRtcConnectionError'; this.diagnostics = diagnostics }
}

export class ConnectionDiagnostics {
  private pc?: RTCPeerConnection
  private channel?: RTCDataChannel
  private sampling = false
  private stopped = false
  private emittedStage = false
  private seen = { local: new Set<string>(), remote: new Set<string>() }
  private value: ConnectionSnapshot
  private change?: (snapshot: ConnectionSnapshot) => void
  private stageChange?: (stage: WebRtcConnectionStage) => void
  constructor(signalingUrl: string, change?: (snapshot: ConnectionSnapshot) => void, stageChange?: (stage: WebRtcConnectionStage) => void) {
    this.change = change; this.stageChange = stageChange
    const endpoint = new URL(signalingUrl); endpoint.search = ''; endpoint.hash = ''; endpoint.username = ''; endpoint.password = ''
    this.value = { stage: 'configuration', signalingUrl: endpoint.href, socketOpen: false, socketState: 'new',
      local: { host: 0, srflx: 0, prflx: 0 }, remote: { host: 0, srflx: 0, prflx: 0 },
      gatheringState: 'new', iceState: 'new', dtlsState: 'new', channelState: 'connecting',
      probes: { sent: 0, received: 0, pairs: 0 }, stunErrors: [] }
  }
  snapshot(): ConnectionSnapshot { return { ...this.value, local: { ...this.value.local }, remote: { ...this.value.remote }, probes: { ...this.value.probes }, stunErrors: this.value.stunErrors.map(item => ({ ...item })) } }
  private publish() { if (!this.stopped) this.change?.(this.snapshot()) }
  advance(stage: WebRtcConnectionStage) {
    if (this.stopped) return
    const before = WEBRTC_CONNECTION_STAGES.indexOf(this.value.stage), next = WEBRTC_CONNECTION_STAGES.indexOf(stage)
    if (next < before || (next === before && this.emittedStage)) return
    this.emittedStage = true
    this.value.stage = stage
    if (stage === 'signaling') this.value.socketState = 'connecting'
    this.stageChange?.(stage)
    this.publish()
  }
  attach(pc: RTCPeerConnection, channel: RTCDataChannel) { this.pc = pc; this.channel = channel; this.observe() }
  socketOpened() { this.value.socketOpen = true; this.value.socketState = 'open'; this.publish() }
  socketClosed() { this.value.socketOpen = false; this.value.socketState = 'closed'; this.publish() }
  candidate(side: 'local' | 'remote', candidate: string) {
    const type = candidate.match(/\btyp\s+(host|srflx|prflx)\b/)?.[1] as keyof Counts | undefined
    if (!type || this.seen[side].has(candidate)) return
    this.seen[side].add(candidate); this.value[side][type]++; this.publish()
  }
  remoteSdp(sdp: string) { for (const line of sdp.split(/\r?\n/)) if (line.startsWith('a=candidate:')) this.candidate('remote', line.slice(2)) }
  stunError(url: string, code: number) {
    if (!url) return
    const server = url.split('?')[0].replace(/^(stuns?:).*@/, '$1').slice(0, 160)
    if (this.value.stunErrors.some(item => item.server === server && item.code === code)) return
    if (this.value.stunErrors.length < 8) this.value.stunErrors.push({ server, code })
    this.publish()
  }
  observe() {
    if (!this.pc || this.stopped) return
    this.value.gatheringState = this.pc.iceGatheringState
    this.value.iceState = this.pc.iceConnectionState
    const dtls = this.pc.sctp?.transport.state
    if (dtls && dtls !== 'new') this.value.dtlsState = dtls
    this.value.channelState = this.channel?.readyState || 'connecting'
    // ICE establishes reachability; DTLS and then SCTP/DCEP can still fail later.
    if (this.value.stage !== 'authentication' && ['connected', 'completed'].includes(this.value.iceState)) {
      if (this.value.dtlsState === 'connected' || this.pc.connectionState === 'connected') this.advance('channel')
      else this.advance('dtls')
    }
    this.publish()
  }
  async sample() {
    if (!this.pc || this.sampling || this.stopped) return
    this.sampling = true
    try {
      const stats = await this.pc.getStats()
      if (this.stopped) return
      const probes = { sent: 0, received: 0, pairs: 0 }
      stats.forEach(item => {
        if (item.type === 'candidate-pair') { probes.pairs++; probes.sent += item.requestsSent || 0; probes.received += item.responsesReceived || 0 }
        if (item.type === 'transport' && item.dtlsState) this.value.dtlsState = item.dtlsState
      })
      this.value.probes = probes; this.observe()
    } catch { /* Some WebViews do not expose handshake stats. Keep observed events. */ }
    finally { this.sampling = false }
  }
  stop() { this.stopped = true; this.seen.local.clear(); this.seen.remote.clear() }
}
