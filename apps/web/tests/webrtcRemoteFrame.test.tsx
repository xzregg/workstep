import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import test from 'node:test'

import WebRtcRemoteFrame, {
  WEBRTC_HEARTBEAT_INTERVAL_MS,
  WEBRTC_NET_CHANGE_PROBE_TIMEOUT_MS,
} from '../src/webrtc/WebRtcRemoteFrame'
import GatewayConnectionStatus from '../src/components/GatewayConnectionStatus'
import { useWebRtcConnectionStore } from '../src/webrtc/webrtcConnectionStore'
import { ICE_DISCONNECT_GRACE_MS } from '../src/webrtc/peerClient'
import { I18nProvider } from '../src/i18n'

test('WebRtcRemoteFrame requires the device key even when gateway claims session_authorized', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('https://gateway.example.com/p2p/dev-bound-1/tasks')

  const originalFetch = globalThis.fetch
  const pairBodies: Array<Record<string, unknown>> = []

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith('/api/webrtc/config?')) {
      return new Response(
        JSON.stringify({
          online: true,
          device_id: 'dev-bound-1',
          device_name: 'Office Mac',
          stun_urls: ['stun:gateway.example.com:3478'],
          direct_only: true,
          session_authorized: true,
          pair_key_salt: 'test-salt',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    if (url === '/api/webrtc/pair') {
      pairBodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>)
      return new Response(JSON.stringify({ detail: 'Invalid pairing key' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch

  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <WebRtcRemoteFrame>
            <div>remote-content</div>
          </WebRtcRemoteFrame>
        </I18nProvider>,
      )
    })
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await Promise.resolve()
      })
    }

    assert.equal(pairBodies.length, 0)
    // After 403 fallback, manual pair key form stays usable and reveals the error.
    assert.equal(document.getElementById('webrtc-remote-pair-key') !== null, true)
    assert.equal(Boolean(document.querySelector('.webrtc-pair-error')), false)
    assert.equal((document.querySelector('.webrtc-pair-form button[type=submit]') as HTMLButtonElement).disabled, true)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

test('WebRtcRemoteFrame tolerates brief ICE disconnect and preserves workbench DOM during auto-reconnect', async () => {
  assert.equal(ICE_DISCONNECT_GRACE_MS, 4000)

  const { window } = installDomEnvironment()
  window.happyDOM.setURL('https://gateway.example.com/p2p/dev-reconn-1/tasks')
  sessionStorage.setItem('workstep-webrtc-pair-key:dev-reconn-1', 'local-secret-1234567890-abcdef')

  const originalFetch = globalThis.fetch
  const originalRtc = globalThis.RTCPeerConnection
  const originalWs = globalThis.WebSocket

  const activePeers: Array<{ pc: FakePeerConnection; channel: FakeChannel }> = []
  let pairCount = 0

  class FakeChannel {
    readyState: RTCDataChannelState = 'connecting'
    bufferedAmount = 0
    binaryType: BinaryType = 'arraybuffer'
    dropPings = false
    onopen: ((ev: Event) => unknown) | null = null
    onclose: ((ev: Event) => unknown) | null = null
    onerror: ((ev: RTCErrorEvent) => unknown) | null = null
    onmessage: ((ev: MessageEvent) => unknown) | null = null

    send(data: string | ArrayBuffer | ArrayBufferView): void {
      if (typeof data !== 'string') return
      const frame = JSON.parse(data) as Record<string, unknown>
      if (frame.type === 'p2p.auth') {
        queueMicrotask(() => {
          this.onmessage?.({ data: JSON.stringify({ type: 'p2p.ready' }) } as MessageEvent)
        })
        return
      }
      if (frame.type === 'p2p.ping' && !this.dropPings) {
        queueMicrotask(() => {
          if (this.readyState === 'open') {
            this.onmessage?.({ data: JSON.stringify({ type: 'p2p.pong', nonce: frame.nonce }) } as MessageEvent)
          }
        })
      }
    }

    close(): void {
      if (this.readyState === 'closed') return
      this.readyState = 'closed'
      this.onclose?.(new Event('close'))
    }
  }

  class FakePeerConnection {
    iceGatheringState: RTCIceGatheringState = 'complete'
    iceConnectionState: RTCIceConnectionState = 'new'
    localDescription: RTCSessionDescription | null = null
    onicecandidate: ((ev: RTCPeerConnectionIceEvent) => unknown) | null = null
    oniceconnectionstatechange: (() => unknown) | null = null
    private channel: FakeChannel | null = null

    addEventListener(): void {}
    removeEventListener(): void {}

    createDataChannel(): RTCDataChannel {
      const ch = new FakeChannel()
      this.channel = ch
      activePeers.push({ pc: this, channel: ch })
      return ch as unknown as RTCDataChannel
    }

    async createOffer(): Promise<RTCSessionDescriptionInit> {
      return { type: 'offer', sdp: 'v=0\r\na=candidate:1 1 udp 1 192.168.1.5 50000 typ host\r\n' }
    }

    async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
      this.localDescription = desc as RTCSessionDescription
    }

    async setRemoteDescription(): Promise<void> {
      this.iceConnectionState = 'connected'
      queueMicrotask(() => {
        if (this.channel && this.channel.readyState !== 'closed') {
          this.channel.readyState = 'open'
          this.channel.onopen?.(new Event('open'))
        }
      })
    }

    async addIceCandidate(): Promise<void> {}

    async getStats(): Promise<RTCStatsReport> {
      return new Map<string, Record<string, unknown>>([
        ['tp', { type: 'transport', selectedCandidatePairId: 'pair-1' }],
        ['pair-1', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'l1', remoteCandidateId: 'r1', currentRoundTripTime: 0.01 }],
        ['l1', { type: 'local-candidate', candidateType: 'host' }],
        ['r1', { type: 'remote-candidate', candidateType: 'srflx' }],
      ]) as unknown as RTCStatsReport
    }

    close(): void {
      this.iceConnectionState = 'closed'
    }
  }

  class FakeWebSocket {
    static OPEN = 1
    readyState = 1
    onmessage: ((ev: MessageEvent) => unknown) | null = null
    onerror: (() => unknown) | null = null
    onclose: (() => unknown) | null = null

    constructor() {
      queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ type: 'client_ready' }) } as MessageEvent)
      })
    }

    send(raw: string): void {
      const msg = JSON.parse(raw) as Record<string, unknown>
      if (msg.type === 'offer') {
        queueMicrotask(() => {
          this.onmessage?.({
            data: JSON.stringify({ type: 'answer', sdp: 'v=0\r\na=candidate:1 1 udp 1 198.51.100.2 40000 typ srflx\r\n' }),
          } as MessageEvent)
        })
      }
    }

    close(): void {
      this.readyState = 3
    }
  }

  globalThis.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith('/api/webrtc/config?')) {
      return new Response(JSON.stringify({
        online: true,
        device_id: 'dev-reconn-1',
        device_name: 'Office Mac',
        stun_urls: ['stun:stun.cloudflare.com:3478'],
        direct_only: true,
        session_authorized: true,
          pair_key_salt: 'test-salt',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url === '/api/webrtc/pair') {
      pairCount += 1
      return new Response(JSON.stringify({
        session_id: `sess-${pairCount}`,
        session_token: `tok-${pairCount}`,
        p2p_ticket: `ticket-${pairCount}`,
        device_name: 'Office Mac',
        stun_urls: ['stun:stun.cloudflare.com:3478'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch

  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <WebRtcRemoteFrame>
            <div data-testid="workbench-child">remote-content</div>
          </WebRtcRemoteFrame>
        </I18nProvider>,
      )
    })
    for (let i = 0; i < 12; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10))
      })
    }

    assert.equal(pairCount, 1)
    assert.equal(Boolean(document.querySelector('[data-webrtc-connected="true"]')), true)
    const childEl = document.querySelector('[data-testid="workbench-child"]')
    assert.equal(childEl !== null, true)

    // Brief ICE 'disconnected' flicker that recovers immediately does NOT drop connection.
    await act(async () => {
      activePeers[0].pc.iceConnectionState = 'disconnected'
      activePeers[0].pc.oniceconnectionstatechange?.()
      await new Promise((r) => setTimeout(r, 30))
      activePeers[0].pc.iceConnectionState = 'connected'
      activePeers[0].pc.oniceconnectionstatechange?.()
    })
    assert.equal(pairCount, 1)

    // Unexpected DataChannel close triggers automatic reconnect while keeping workbench child mounted.
    await act(async () => {
      activePeers[0].channel.close()
    })
    assert.equal(document.querySelector('[data-testid="workbench-child"]') === childEl, true)

    for (let i = 0; i < 30 && pairCount < 2; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60))
      })
    }
    assert.equal(pairCount >= 2, true)
    assert.equal(document.querySelector('[data-testid="workbench-child"]') === childEl, true)
    assert.equal(Boolean(document.querySelector('[data-webrtc-connected="true"]')), true)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    globalThis.RTCPeerConnection = originalRtc
    globalThis.WebSocket = originalWs
    await window.happyDOM.close()
  }
})

test('WebRtcRemoteFrame shows live millisecond latency matching Gateway and actively reconnects on network change probe failure', async () => {
  assert.equal(WEBRTC_HEARTBEAT_INTERVAL_MS, 10000)
  assert.equal(WEBRTC_NET_CHANGE_PROBE_TIMEOUT_MS, 1500)

  const { window } = installDomEnvironment()
  window.happyDOM.setURL('https://gateway.example.com/p2p/dev-probe-1/tasks')
  sessionStorage.setItem('workstep-webrtc-pair-key:dev-probe-1', 'local-secret-1234567890-abcdef')

  const originalFetch = globalThis.fetch
  const originalRtc = globalThis.RTCPeerConnection
  const originalWs = globalThis.WebSocket
  const origNavConn = Object.getOwnPropertyDescriptor(window.navigator, 'connection')
  const connTarget = new window.EventTarget()
  Object.defineProperty(window.navigator, 'connection', { configurable: true, value: connTarget })

  const activePeers: Array<{ pc: FakePeerConnection; channel: FakeChannel }> = []
  let pairCount = 0

  class FakeChannel {
    readyState: RTCDataChannelState = 'connecting'
    bufferedAmount = 0
    binaryType: BinaryType = 'arraybuffer'
    dropPings = false
    pingDelayMs = 12
    onopen: ((ev: Event) => unknown) | null = null
    onclose: ((ev: Event) => unknown) | null = null
    onerror: ((ev: RTCErrorEvent) => unknown) | null = null
    onmessage: ((ev: MessageEvent) => unknown) | null = null

    send(data: string | ArrayBuffer | ArrayBufferView): void {
      if (typeof data !== 'string') return
      const frame = JSON.parse(data) as Record<string, unknown>
      if (frame.type === 'p2p.auth') {
        queueMicrotask(() => {
          this.onmessage?.({ data: JSON.stringify({ type: 'p2p.ready' }) } as MessageEvent)
        })
        return
      }
      if (frame.type === 'p2p.ping' && !this.dropPings) {
        setTimeout(() => {
          if (this.readyState === 'open') {
            this.onmessage?.({ data: JSON.stringify({ type: 'p2p.pong', nonce: frame.nonce }) } as MessageEvent)
          }
        }, this.pingDelayMs)
      }
    }

    close(): void {
      if (this.readyState === 'closed') return
      this.readyState = 'closed'
      this.onclose?.(new Event('close'))
    }
  }

  class FakePeerConnection {
    iceGatheringState: RTCIceGatheringState = 'complete'
    iceConnectionState: RTCIceConnectionState = 'new'
    localDescription: RTCSessionDescription | null = null
    onicecandidate: ((ev: RTCPeerConnectionIceEvent) => unknown) | null = null
    oniceconnectionstatechange: (() => unknown) | null = null
    private channel: FakeChannel | null = null

    addEventListener(): void {}
    removeEventListener(): void {}

    createDataChannel(): RTCDataChannel {
      const ch = new FakeChannel()
      this.channel = ch
      activePeers.push({ pc: this, channel: ch })
      return ch as unknown as RTCDataChannel
    }

    async createOffer(): Promise<RTCSessionDescriptionInit> {
      return { type: 'offer', sdp: 'v=0\r\na=candidate:1 1 udp 1 192.168.1.5 50000 typ host\r\n' }
    }

    async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
      this.localDescription = desc as RTCSessionDescription
    }

    async setRemoteDescription(): Promise<void> {
      this.iceConnectionState = 'connected'
      queueMicrotask(() => {
        if (this.channel && this.channel.readyState !== 'closed') {
          this.channel.readyState = 'open'
          this.channel.onopen?.(new Event('open'))
        }
      })
    }

    async addIceCandidate(): Promise<void> {}

    async getStats(): Promise<RTCStatsReport> {
      return new Map<string, Record<string, unknown>>([
        ['tp', { type: 'transport', selectedCandidatePairId: 'pair-1' }],
        ['pair-1', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'l1', remoteCandidateId: 'r1', currentRoundTripTime: 0.025 }],
        ['l1', { type: 'local-candidate', candidateType: 'host' }],
        ['r1', { type: 'remote-candidate', candidateType: 'srflx' }],
      ]) as unknown as RTCStatsReport
    }

    close(): void {
      this.iceConnectionState = 'closed'
    }
  }

  class FakeWebSocket {
    static OPEN = 1
    readyState = 1
    onmessage: ((ev: MessageEvent) => unknown) | null = null
    onerror: (() => unknown) | null = null
    onclose: (() => unknown) | null = null

    constructor() {
      queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ type: 'client_ready' }) } as MessageEvent)
      })
    }

    send(raw: string): void {
      const msg = JSON.parse(raw) as Record<string, unknown>
      if (msg.type === 'offer') {
        queueMicrotask(() => {
          this.onmessage?.({
            data: JSON.stringify({ type: 'answer', sdp: 'v=0\r\na=candidate:1 1 udp 1 198.51.100.2 40000 typ srflx\r\n' }),
          } as MessageEvent)
        })
      }
    }

    close(): void {
      this.readyState = 3
    }
  }

  globalThis.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith('/api/webrtc/config?')) {
      return new Response(JSON.stringify({
        online: true,
        device_id: 'dev-probe-1',
        device_name: 'Studio Mac',
        stun_urls: ['stun:stun.cloudflare.com:3478'],
        direct_only: true,
        session_authorized: true,
          pair_key_salt: 'test-salt',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url === '/api/webrtc/pair') {
      pairCount += 1
      return new Response(JSON.stringify({
        session_id: `sess-${pairCount}`,
        session_token: `tok-${pairCount}`,
        p2p_ticket: `ticket-${pairCount}`,
        device_name: 'Studio Mac',
        stun_urls: ['stun:stun.cloudflare.com:3478'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch

  useWebRtcConnectionStore.setState({ connected: false, reconnecting: false, latencyMs: null, deviceName: '' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let resumeCount = 0
  const onResumeEvent = () => {
    resumeCount += 1
  }
  window.addEventListener('workstep:resume', onResumeEvent)

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <WebRtcRemoteFrame>
            <div data-testid="workbench-child">
              <GatewayConnectionStatus onOpenSettings={() => {}} />
            </div>
          </WebRtcRemoteFrame>
        </I18nProvider>,
      )
    })

    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10))
      })
    }

    assert.equal(pairCount, 1)
    const childEl = container.querySelector('[data-testid="workbench-child"]')
    assert.ok(childEl !== null)
    const pathEl = container.querySelector('[data-testid="webrtc-candidate-path"]')
    assert.equal(pathEl?.textContent, 'host ↔ srflx')

    const latencyEl = container.querySelector('[data-testid="webrtc-latency"]')
    assert.ok(latencyEl !== null)
    assert.match(latencyEl.textContent || '', /^· \d+ ms$/)

    const sidebarStatus = container.querySelector('.gateway-connection-status')
    assert.ok(sidebarStatus !== null)
    assert.equal(sidebarStatus.classList.contains('gateway-connection-status--online'), true)
    assert.match(sidebarStatus.querySelector('[role=status]')?.textContent || '', /^(?:P2P 直连|P2P Direct) · \d+ ms$/)

    // Threshold styling matches Gateway (499 normal, 500-1000 warning, >1000 slow)
    for (const [ms, warning, slow] of [
      [499, false, false],
      [500, true, false],
      [1000, true, false],
      [1001, false, true],
    ] as const) {
      await act(async () => {
        useWebRtcConnectionStore.setState({ connected: true, reconnecting: false, latencyMs: ms, deviceName: 'Studio Mac' })
      })
      const sidebarLatency = container.querySelector('.gateway-connection-status .gateway-connection-latency')
      assert.ok(sidebarLatency !== null)
      assert.equal(sidebarLatency.textContent, ` · ${ms} ms`)
      assert.equal(sidebarLatency.classList.contains('gateway-connection-latency--warning'), warning)
      assert.equal(sidebarLatency.classList.contains('gateway-connection-latency--slow'), slow)
    }

    // Benign network change where peer still responds to p2p.ping does NOT tear down or re-pair.
    await act(async () => {
      connTarget.dispatchEvent(new Event('change'))
      await new Promise((r) => setTimeout(r, 60))
    })
    assert.equal(pairCount, 1)
    assert.equal(container.querySelector('[data-testid="workbench-child"]') === childEl, true)

    // Silent network drop (channel stays 'open' & ICE stays 'connected', but UDP path drops pings)
    // triggers probe timeout -> automatic reconnect preserving workbench child and firing workstep:resume.
    activePeers[0].channel.dropPings = true
    await act(async () => {
      connTarget.dispatchEvent(new Event('change'))
    })

    for (let i = 0; i < 45 && pairCount < 2; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60))
      })
    }

    assert.equal(pairCount >= 2, true)
    assert.equal(container.querySelector('[data-testid="workbench-child"]') === childEl, true)
    assert.equal(Boolean(container.querySelector('[data-webrtc-connected="true"]')), true)
    assert.equal(resumeCount >= 1, true)
    const recoveredStatus = container.querySelector('.gateway-connection-status [role=status]')?.textContent || ''
    assert.match(recoveredStatus, /^(?:P2P 直连|P2P Direct) · \d+ ms$/)
    assert.match(container.querySelector('[data-testid="webrtc-latency"]')?.textContent || '', /^· \d+ ms$/)
  } finally {
    container.remove()
    window.removeEventListener('workstep:resume', onResumeEvent)
    if (origNavConn) Object.defineProperty(window.navigator, 'connection', origNavConn)
    else Reflect.deleteProperty(window.navigator, 'connection')
    await act(async () => root.unmount())
    useWebRtcConnectionStore.setState({ connected: false, reconnecting: false, latencyMs: null, deviceName: '' })
    globalThis.fetch = originalFetch
    globalThis.RTCPeerConnection = originalRtc
    globalThis.WebSocket = originalWs
    await window.happyDOM.close()
  }
})
