import test from 'node:test'
import assert from 'node:assert/strict'
import { ConnectionDiagnostics, classifyConnectionFailure } from '../src/webrtc/connectionDiagnostics'

function peer(ice = 'checking', dtls = 'new', channel = 'connecting') {
  return { pc: { iceConnectionState: ice, iceGatheringState: 'complete', connectionState: dtls === 'connected' ? 'connected' : 'connecting',
    sctp: { transport: { state: dtls } }, getStats: async () => new Map() } as unknown as RTCPeerConnection,
    channel: { readyState: channel } as RTCDataChannel }
}

test('diagnostics distinguish signal socket from server acknowledgement without recording credentials', () => {
  const diagnostics = new ConnectionDiagnostics('wss://gateway.example/ws/webrtc/client')
  diagnostics.advance('signaling')
  assert.equal(classifyConnectionFailure(diagnostics.snapshot()), 'signal_connect')
  diagnostics.socketOpened()
  assert.equal(classifyConnectionFailure(diagnostics.snapshot()), 'signal_ready')
  assert.equal(diagnostics.snapshot().signalingUrl, 'wss://gateway.example/ws/webrtc/client')
})

test('ICE evidence separates missing candidates, unreachable paths and later handshakes', async () => {
  const diagnostics = new ConnectionDiagnostics('wss://gateway.example/ws/webrtc/client')
  const { pc, channel } = peer()
  diagnostics.attach(pc, channel)
  diagnostics.advance('ice')
  assert.equal(classifyConnectionFailure(diagnostics.snapshot()), 'local_candidates')
  assert.equal(classifyConnectionFailure({ ...diagnostics.snapshot(), iceState: 'failed' }), 'local_candidates')
  diagnostics.candidate('local', 'candidate:1 1 udp 123 192.168.1.5 12345 typ host')
  assert.equal(classifyConnectionFailure(diagnostics.snapshot()), 'remote_candidates')
  diagnostics.candidate('remote', 'candidate:2 1 udp 123 203.0.113.1 54321 typ srflx')
  assert.equal(classifyConnectionFailure(diagnostics.snapshot()), 'ice_path')
  diagnostics.candidate('local', 'candidate:1 1 udp 123 192.168.1.5 12345 typ host')
  assert.equal(diagnostics.snapshot().local.host, 1)
  assert.ok(!JSON.stringify(diagnostics.snapshot()).includes('192.168.1.5'))
  Object.assign(pc, { iceConnectionState: 'connected' })
  Object.assign(pc.sctp!.transport, { state: 'connecting' })
  diagnostics.observe()
  assert.equal(diagnostics.snapshot().stage, 'dtls')
  assert.equal(classifyConnectionFailure(diagnostics.snapshot()), 'dtls')
  Object.assign(pc.sctp!.transport, { state: 'connected' })
  diagnostics.observe()
  assert.equal(diagnostics.snapshot().stage, 'channel')
  assert.equal(classifyConnectionFailure(diagnostics.snapshot()), 'datachannel')
  diagnostics.advance('ice')
  assert.equal(diagnostics.snapshot().stage, 'channel', 'late ICE events cannot move progress backwards')
})

test('sampling keeps counts and handshake state, never candidate IPs, SDP or session tokens', async () => {
  const diagnostics = new ConnectionDiagnostics('wss://gateway.example/ws/webrtc/client')
  const { pc, channel } = peer()
  pc.getStats = async () => new Map([
    ['pair', { type: 'candidate-pair', state: 'in-progress', requestsSent: 7, responsesReceived: 0 }],
    ['private', { type: 'local-candidate', address: '10.1.2.3', port: 65000 }],
    ['transport', { type: 'transport', dtlsState: 'connecting' }],
  ]) as unknown as RTCStatsReport
  diagnostics.attach(pc, channel)
  diagnostics.stunError('stun:server.example:3478?secret=private', 701)
  diagnostics.candidate('local', 'candidate:1 1 udp 123 203.0.113.2 12345 typ srflx')
  await diagnostics.sample()
  const snapshot = diagnostics.snapshot()
  assert.deepEqual(snapshot.probes, { sent: 7, received: 0, pairs: 1 })
  assert.equal(snapshot.dtlsState, 'connecting')
  assert.equal(snapshot.stunErrors[0].server, 'stun:server.example:3478')
  assert.equal(snapshot.local.srflx, 1, 'one STUN failure does not hide successful public candidates')
  assert.ok(!JSON.stringify(snapshot).includes('private'))
  assert.ok(!JSON.stringify(snapshot).includes('10.1.2.3'))
})
