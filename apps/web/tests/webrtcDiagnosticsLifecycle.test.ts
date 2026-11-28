import './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import { installDomEnvironment } from './helpers/domEnv'
import { connectWebRtcDirect } from '../src/webrtc/peerClient'
import { WebRtcConnectionError, classifyConnectionFailure, type ConnectionSnapshot } from '../src/webrtc/connectionDiagnostics'

for (const [ice, dtls, expected] of [['checking', 'new', 'ice_path'], ['connected', 'connecting', 'dtls'], ['connected', 'connected', 'datachannel']] as const) {
  test(`connection timeout preserves ${expected} evidence before closing the peer`, async () => {
    const { window } = installDomEnvironment()
    window.happyDOM.setURL('https://gateway.example/p2p/device/')
    const saved = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, pc: globalThis.RTCPeerConnection }
    const timeouts = new Set<ReturnType<typeof setTimeout>>()
    window.setTimeout = ((callback: () => void, delay: number) => { const timer = setTimeout(callback, delay >= 10000 ? 25 : delay); timeouts.add(timer); return timer }) as unknown as typeof window.setTimeout
    window.clearTimeout = (timer => { clearTimeout(timer as unknown as ReturnType<typeof setTimeout>) }) as typeof window.clearTimeout
    class Socket {
      static OPEN = 1
      readyState = 1
      onopen?: () => void
      onmessage?: (event: {data: string}) => void
      onclose?: () => void
      onerror?: () => void
      constructor() { queueMicrotask(() => { this.onopen?.(); this.onmessage?.({data:JSON.stringify({type:'client_ready'})}) }) }
      send(value: string) {
        if (JSON.parse(value).type === 'offer') queueMicrotask(() => this.onmessage?.({data:JSON.stringify({type:'answer',sdp:'a=candidate:remote 1 udp 123 203.0.113.1 5000 typ srflx'})}))
      }
      close() { this.readyState = 3; this.onclose?.() }
    }
    class Peer {
      iceConnectionState: string = ice
      iceGatheringState = 'complete'
      connectionState = dtls === 'connected' ? 'connected' : 'connecting'
      sctp = { transport: Object.assign(new EventTarget(), {state:dtls}) }
      localDescription?: {sdp: string}
      onicecandidate?: (event: {candidate: {candidate: string}}) => void
      channel = {readyState:'connecting',close(){}}
      createDataChannel() { return this.channel }
      async createOffer() { return {sdp:'v=0'} }
      async setLocalDescription(value: {sdp: string}) { this.localDescription=value; this.onicecandidate?.({candidate:{candidate:'candidate:local 1 udp 123 192.168.1.2 5001 typ host'}}) }
      async setRemoteDescription() {}
      async getStats() { return new Map() }
      close() { this.iceConnectionState='closed' }
    }
    globalThis.WebSocket = Socket as unknown as typeof WebSocket
    globalThis.RTCPeerConnection = Peer as unknown as typeof RTCPeerConnection
    globalThis.fetch = async input => String(input).includes('/config')
      ? Response.json({pair_key_salt:'salt',stun_urls:[],online:true,device_id:'device',device_name:'Desktop'})
      : Response.json({session_token:'private-session-token',p2p_ticket:'private-ticket',stun_urls:[]})
    const snapshots: ConnectionSnapshot[] = []
    try {
      await assert.rejects(connectWebRtcDirect({deviceId:'device',pairKey:'a'.repeat(24),onDiagnostics:snapshot=>snapshots.push(snapshot)}), error => {
        assert.ok(error instanceof WebRtcConnectionError)
        assert.equal(classifyConnectionFailure(error.diagnostics), expected)
        assert.equal(error.diagnostics.iceState, ice, 'cleanup must not overwrite failure evidence with closed')
        assert.equal(error.diagnostics.local.host, 1)
        assert.equal(error.diagnostics.remote.srflx, 1)
        assert.ok(!JSON.stringify(error.diagnostics).includes('private-session-token'))
        return true
      })
      assert.ok(snapshots.length > 3)
    } finally {
      for (const timer of timeouts) clearTimeout(timer)
      globalThis.fetch=saved.fetch;globalThis.WebSocket=saved.WebSocket;globalThis.RTCPeerConnection=saved.pc
      await window.happyDOM.close()
    }
  })
}
