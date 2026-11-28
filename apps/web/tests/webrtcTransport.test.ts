import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  normalizeDaemonPath,
  shouldProxyWebRtcHttp,
  WebRtcBinaryKind,
  WebRtcTransportClient,
  verifyNonRelayCandidatePair,
  type DataChannelLike,
} from '../src/webrtc/transportAdapter'
import { isWebRtcRemoteBrowser, webrtcDeviceIdFromPath, webrtcWorkspacePath } from '../src/webrtc/webrtcLocation'

function installWindowLocation(url: string, fn: () => void | Promise<void>) {
  const parsed = new URL(url)
  const existing = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        href: parsed.href,
        origin: parsed.origin,
        protocol: parsed.protocol,
        host: parsed.host,
        hostname: parsed.hostname,
        port: parsed.port,
        pathname: parsed.pathname,
        search: parsed.search,
        hash: parsed.hash,
      },
    },
  })
  return Promise.resolve(fn()).finally(() => {
    if (existing) Object.defineProperty(globalThis, 'window', existing)
    else Reflect.deleteProperty(globalThis, 'window')
  })
}

class MockDataChannel implements DataChannelLike {
  readyState: RTCDataChannelState = 'open'
  bufferedAmount = 0
  binaryType: BinaryType = 'arraybuffer'
  onopen: ((ev: Event) => unknown) | null = null
  onclose: ((ev: Event) => unknown) | null = null
  onerror: ((ev: RTCErrorEvent) => unknown) | null = null
  onmessage: ((ev: MessageEvent) => unknown) | null = null
  sentTexts: string[] = []
  sentBytes: Uint8Array[] = []
  onSend?: (data: string | Uint8Array) => void

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === 'string') {
      this.sentTexts.push(data)
      this.onSend?.(data)
      return
    }
    const view = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    const copy = new Uint8Array(view)
    this.sentBytes.push(copy)
    this.onSend?.(copy)
  }

  emitMessage(data: string | Uint8Array): void {
    const payload = typeof data === 'string'
      ? data
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    this.onmessage?.({ data: payload } as MessageEvent)
  }

  close(): void {
    this.readyState = 'closed'
    this.onclose?.(new Event('close'))
  }
}

test('large HTTP uploads wait for the channel buffer and honor cancellation', async () => {
  const channel = new MockDataChannel()
  const transport = new WebRtcTransportClient(channel)
  channel.onSend = (item) => {
    if (typeof item !== 'string') channel.bufferedAmount += item.byteLength
  }
  const controller = new AbortController()
  const upload = transport.fetch('https://signal.example.com/api/upload', {
    method: 'POST', body: 'x'.repeat(2 * 1024 * 1024), signal: controller.signal,
  })
  const rejected = assert.rejects(upload, { name: 'AbortError' })
  await new Promise(resolve => setTimeout(resolve, 20))
  const queued = channel.sentBytes.length
  assert.ok(queued > 0 && queued < 32)
  channel.bufferedAmount = 0
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.ok(channel.sentBytes.length > queued && channel.sentBytes.length < 64)
  controller.abort()
  await rejected
  const stopped = channel.sentBytes.length
  channel.bufferedAmount = 0
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(channel.sentBytes.length, stopped)
  transport.close()
})

test('upload credits bound queued data without delaying heartbeats', async () => {
  const channel = new MockDataChannel()
  const transport = new WebRtcTransportClient(channel)
  channel.onSend = (item) => {
    if (typeof item !== 'string') return
    const message = JSON.parse(item)
    if (message.type === 'p2p.auth') channel.emitMessage(JSON.stringify({ type: 'p2p.ready', upload_flow_control: true }))
    if (message.type === 'p2p.ping') channel.emitMessage(JSON.stringify({ type: 'p2p.pong', nonce: message.nonce }))
  }
  await transport.authenticate('ticket', 'secret')
  const abort = new AbortController()
  const upload = transport.fetch('/api/upload', { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024), signal: abort.signal })
  const rejected = assert.rejects(upload, { name: 'AbortError' })
  try {
    await new Promise(resolve => setTimeout(resolve, 20))
    const start = channel.sentTexts.map(text => JSON.parse(text)).find(message => message.type === 'http.request')
    assert.equal(start.payload.upload_flow_control, true)
    assert.equal(channel.sentBytes.length, 0)
    channel.emitMessage(JSON.stringify({ stream_id: start.stream_id, type: 'window.update', payload: { credits: 2 } }))
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(channel.sentBytes.length, 2)
    assert.ok(await transport.ping() >= 0)
    assert.equal(channel.sentBytes.length, 2)
  } finally {
    abort.abort()
    await rejected
    transport.close()
  }
})

test('detects /p2p/<device_id> basename and device id', async () => {
  await installWindowLocation('https://signal.example.com/p2p/dev-123/tasks?project=p1', () => {
    assert.equal(webrtcWorkspacePath(), '/p2p/dev-123')
    assert.equal(webrtcDeviceIdFromPath(), 'dev-123')
    assert.equal(isWebRtcRemoteBrowser(), true)
  })
  await installWindowLocation('https://signal.example.com/workspace/dev-123/tasks', () => {
    assert.equal(webrtcWorkspacePath(), '')
    assert.equal(webrtcDeviceIdFromPath(), '')
    assert.equal(isWebRtcRemoteBrowser(), false)
  })
})

test('verifyNonRelayCandidatePair rejects relay candidates and accepts host/srflx/prflx', async () => {
  const makeStats = (localType: string, remoteType: string) => new Map<string, Record<string, unknown>>([
    ['tp', { type: 'transport', selectedCandidatePairId: 'pair-1' }],
    ['pair-1', {
      type: 'candidate-pair',
      state: 'succeeded',
      nominated: true,
      localCandidateId: 'loc-1',
      remoteCandidateId: 'rem-1',
      currentRoundTripTime: 0.014,
    }],
    ['loc-1', { type: 'local-candidate', candidateType: localType }],
    ['rem-1', { type: 'remote-candidate', candidateType: remoteType }],
  ])

  const direct = verifyNonRelayCandidatePair(makeStats('host', 'srflx') as unknown as RTCStatsReport)
  assert.deepEqual(direct, { localType: 'host', remoteType: 'srflx', rttMs: 14 })

  assert.throws(
    () => verifyNonRelayCandidatePair(makeStats('host', 'relay') as unknown as RTCStatsReport),
    /relay/i,
  )
  assert.throws(
    () => verifyNonRelayCandidatePair(makeStats('relay', 'srflx') as unknown as RTCStatsReport),
    /relay/i,
  )
})

test('WebRtcTransportClient bridges streaming fetch, binary upload, abort, and WebSocket over DataChannel', async () => {
  const channel = new MockDataChannel()
  const transport = new WebRtcTransportClient(channel)
  let downloadStreamId: string | undefined

  channel.onSend = (item) => {
    if (typeof item !== 'string') {
      const decoded = decodeBinaryFrame(item)
      if (decoded.kind === WebRtcBinaryKind.httpRequestBody && decoded.final) {
        queueMicrotask(() => {
          channel.emitMessage(JSON.stringify({
            stream_id: decoded.streamId,
            type: 'http.response',
            payload: { phase: 'start', status: 200, headers: [['content-type', 'application/json']] },
          }))
          const reply = new TextEncoder().encode(JSON.stringify({ uploadedBytes: decoded.payload.byteLength }))
          channel.emitMessage(encodeBinaryFrame(WebRtcBinaryKind.httpResponseBody, decoded.streamId, reply, true))
          channel.emitMessage(JSON.stringify({
            stream_id: decoded.streamId,
            type: 'http.response',
            payload: { phase: 'end' },
          }))
        })
      }
      if (decoded.kind === WebRtcBinaryKind.websocketDataText) {
        const msg = new TextDecoder().decode(decoded.payload)
        queueMicrotask(() => {
          channel.emitMessage(encodeBinaryFrame(
            WebRtcBinaryKind.websocketDataText,
            decoded.streamId,
            new TextEncoder().encode(`pong:${msg}`),
            true,
          ))
        })
      }
      return
    }

    const msg = JSON.parse(item)
    if (msg.type === 'p2p.auth') {
      assert.equal(msg.pair_key, 'local-secret-1234567890-abcdef')
      assert.equal(msg.ticket, 'ticket-abc')
      channel.emitMessage(JSON.stringify({
        type: 'p2p.ready',
        version: 1,
        device_id: 'dev-1',
        candidate_info: { local_type: 'host', remote_type: 'srflx' },
      }))
      return
    }
    if (msg.type === 'http.request' && msg.payload.phase === 'start' && msg.payload.path === '/api/stream') {
      downloadStreamId = msg.stream_id
      queueMicrotask(() => {
        channel.emitMessage(JSON.stringify({
          stream_id: msg.stream_id,
          type: 'http.response',
          payload: { phase: 'start', status: 200, headers: [['content-type', 'application/octet-stream']] },
        }))
        const c1 = new Uint8Array([1, 2, 3, 4])
        const c2 = new Uint8Array([5, 6, 7, 8])
        channel.emitMessage(encodeBinaryFrame(WebRtcBinaryKind.httpResponseBody, msg.stream_id, c1, false))
        channel.emitMessage(encodeBinaryFrame(WebRtcBinaryKind.httpResponseBody, msg.stream_id, c2, true))
      })
      return
    }
    if (msg.type === 'window.update' && msg.stream_id === downloadStreamId) {
      assert.equal(msg.payload.credits, 2)
      channel.emitMessage(JSON.stringify({
        stream_id: msg.stream_id, type: 'http.response', payload: { phase: 'end' },
      }))
    }
    if (msg.type === 'websocket.open') {
      queueMicrotask(() => {
        channel.emitMessage(JSON.stringify({
          stream_id: msg.stream_id,
          type: 'websocket.open',
          payload: { accepted: true },
        }))
      })
    }
  }

  const ready = await transport.authenticate('ticket-abc', 'local-secret-1234567890-abcdef')
  assert.equal(ready.device_id, 'dev-1')

  // 1) Streaming response + window.update credit ack
  const dlRes = await transport.fetch('https://signal.example.com/api/stream')
  assert.equal(dlRes.status, 200)
  assert.equal(channel.sentTexts.some((t) => JSON.parse(t).type === 'window.update'), false)
  const dlBytes = new Uint8Array(await dlRes.arrayBuffer())
  assert.deepEqual(Array.from(dlBytes), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.ok(channel.sentTexts.some((t) => JSON.parse(t).type === 'window.update'))

  // 2) Binary upload
  const upBody = new Uint8Array(1024).fill(7)
  const upRes = await transport.fetch('https://signal.example.com/api/upload', {
    method: 'POST',
    body: upBody,
  })
  assert.deepEqual(await upRes.json(), { uploadedBytes: 1024 })

  // 3) Aborted request sends cancel frame
  const controller = new AbortController()
  const abortPromise = transport.fetch('https://signal.example.com/api/hang', { signal: controller.signal })
  controller.abort()
  await assert.rejects(abortPromise, { name: 'AbortError' })
  assert.ok(channel.sentTexts.some((t) => JSON.parse(t).type === 'cancel'))

  // 4) Multiplexed WebSocket over DataChannel
  const ws = transport.createWebSocket('wss://signal.example.com/ws')
  const received: string[] = []
  await new Promise<void>((resolve) => {
    ws.onopen = () => { ws.send('hello') }
    ws.onmessage = (ev) => {
      received.push(String(ev.data))
      ws.close()
    }
    ws.onclose = () => resolve()
  })
  assert.deepEqual(received, ['pong:hello'])

  // 5) Arbitrary custom daemon path under /p2p/<device_id>/ normalizes cleanly
  await installWindowLocation('https://signal.example.com/p2p/dev-1/chat', async () => {
    let seenPath = ''
    channel.onSend = (item) => {
      if (typeof item !== 'string') return
      const msg = JSON.parse(item)
      if (msg.type === 'http.request' && msg.payload.phase === 'start') {
        seenPath = msg.payload.path
        queueMicrotask(() => {
          channel.emitMessage(JSON.stringify({
            stream_id: msg.stream_id,
            type: 'http.response',
            payload: { phase: 'start', status: 200, headers: [['content-type', 'application/json']] },
          }))
          channel.emitMessage(encodeBinaryFrame(
            WebRtcBinaryKind.httpResponseBody,
            msg.stream_id,
            new TextEncoder().encode(JSON.stringify({ ok: true })),
            true,
          ))
          channel.emitMessage(JSON.stringify({
            stream_id: msg.stream_id,
            type: 'http.response',
            payload: { phase: 'end' },
          }))
        })
      }
    }
    const customRes = await transport.fetch('/p2p/dev-1/custom-feature/v2')
    assert.deepEqual(await customRes.json(), { ok: true })
    assert.equal(seenPath, '/custom-feature/v2')
  })

  transport.close()
})

test('shouldProxyWebRtcHttp defaults to proxying arbitrary same-origin paths while keeping signaling and assets local', async () => {
  await installWindowLocation('https://signal.example.com/p2p/dev-123/chat', () => {
    assert.equal(normalizeDaemonPath('/p2p/dev-123/mcp/tools'), '/mcp/tools')
    assert.equal(normalizeDaemonPath('/p2p/dev-123'), '/')
    assert.equal(shouldProxyWebRtcHttp('/api/project/list'), true)
    assert.equal(shouldProxyWebRtcHttp('/mcp/tools'), true)
    assert.equal(shouldProxyWebRtcHttp('/custom/v2/export'), true)
    assert.equal(shouldProxyWebRtcHttp('relative-feature'), true)
    assert.equal(shouldProxyWebRtcHttp('/api/webrtc/pair'), false)
    assert.equal(shouldProxyWebRtcHttp('/p2p/dev-123/api/webrtc/config'), false)
    assert.equal(shouldProxyWebRtcHttp('/assets/web-abc.js'), false)
    assert.equal(shouldProxyWebRtcHttp('/p2p/dev-123/assets/chunk.js'), false)
    assert.equal(shouldProxyWebRtcHttp('/workspace-assets/initial-abc.js'), false)
    assert.equal(shouldProxyWebRtcHttp('/p2p/dev-123/workspace-assets/chunk.css'), false)
    assert.equal(shouldProxyWebRtcHttp('/favicon.svg'), false)
    assert.equal(shouldProxyWebRtcHttp('blob:https://signal.example.com/123'), false)
    assert.equal(shouldProxyWebRtcHttp('data:image/png;base64,AAA'), false)
    assert.equal(shouldProxyWebRtcHttp('https://other.example.com/api/project/list'), false)
  })
})

test('WebRtcTransportClient.ping measures latency on matching p2p.pong, ignores wrong nonce, and rejects on timeout or close', async () => {
  const channel = new MockDataChannel()
  const transport = new WebRtcTransportClient(channel)

  let ignorePong = false
  channel.onSend = (raw) => {
    if (typeof raw !== 'string') return
    const frame = JSON.parse(raw) as Record<string, unknown>
    if (frame.type !== 'p2p.ping' || ignorePong) return
    queueMicrotask(() => {
      // Mismatched nonce must be ignored.
      channel.emitMessage(JSON.stringify({ type: 'p2p.pong', nonce: 'wrong-nonce' }))
      channel.emitMessage(JSON.stringify({ type: 'p2p.pong', nonce: frame.nonce }))
    })
  }

  const rttMs = await transport.ping(500)
  assert.equal(typeof rttMs, 'number')
  assert.equal(rttMs >= 0, true)

  // Missing pong rejects when timeout expires.
  ignorePong = true
  await assert.rejects(() => transport.ping(25), /timed out/i)

  // Pending ping rejects immediately when DataChannel closes.
  const pendingOnClose = transport.ping(5000)
  transport.close()
  await assert.rejects(() => pendingOnClose, /closed/i)

  // Subsequent ping on closed transport rejects immediately.
  await assert.rejects(() => transport.ping(100), /not open/i)
})
