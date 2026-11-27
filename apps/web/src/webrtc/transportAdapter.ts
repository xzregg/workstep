/**
 * Multiplexed HTTP/WebSocket transport adapter over RTCDataChannel.
 * Mirrors WorkStep Gateway ProxyFrame semantics plus compact binary chunk frames.
 */

export const WEBRTC_PROXY_CHANNEL_LABEL = 'workstep-proxy-v1'
const BINARY_MAGIC = 0x57 // 'W'
const BINARY_VERSION = 1
const CHUNK_BYTES = 16384
const DIRECT_CANDIDATE_TYPES = new Set(['host', 'srflx', 'prflx'])

export const WebRtcBinaryKind = {
  httpRequestBody: 1,
  httpResponseBody: 2,
  websocketDataBytes: 3,
  websocketDataText: 4,
} as const

export type WebRtcBinaryKind = (typeof WebRtcBinaryKind)[keyof typeof WebRtcBinaryKind]

export interface DataChannelLike {
  readyState: RTCDataChannelState
  bufferedAmount?: number
  binaryType: BinaryType
  onopen: ((ev: Event) => unknown) | null
  onclose: ((ev: Event) => unknown) | null
  onerror: ((ev: RTCErrorEvent) => unknown) | null
  onmessage: ((ev: MessageEvent) => unknown) | null
  send(data: string | ArrayBuffer | ArrayBufferView): void
  close(): void
}

export interface DirectCandidateInfo {
  localType: string
  remoteType: string
  rttMs: number | null
}

interface ProxyFramePayload {
  stream_id: string
  type: string
  payload: Record<string, unknown>
}

export function encodeBinaryFrame(
  kind: WebRtcBinaryKind,
  streamId: string,
  payload: Uint8Array,
  final = false,
): Uint8Array {
  const streamBytes = new TextEncoder().encode(streamId)
  if (!streamBytes.length || streamBytes.length > 255) {
    throw new Error('Invalid DataChannel stream_id length')
  }
  const out = new Uint8Array(5 + streamBytes.length + payload.byteLength)
  out[0] = BINARY_MAGIC
  out[1] = BINARY_VERSION
  out[2] = kind
  out[3] = final ? 1 : 0
  out[4] = streamBytes.length
  out.set(streamBytes, 5)
  out.set(payload, 5 + streamBytes.length)
  return out
}

export function decodeBinaryFrame(raw: ArrayBuffer | Uint8Array): {
  kind: WebRtcBinaryKind
  streamId: string
  final: boolean
  payload: Uint8Array
} {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
  if (bytes.byteLength < 6 || bytes[0] !== BINARY_MAGIC || bytes[1] !== BINARY_VERSION) {
    throw new Error('Invalid WebRTC binary frame')
  }
  const kind = bytes[2] as WebRtcBinaryKind
  const final = (bytes[3] & 1) === 1
  const streamLen = bytes[4]
  if (streamLen === 0 || bytes.byteLength < 5 + streamLen) {
    throw new Error('Invalid WebRTC binary stream_id')
  }
  const streamId = new TextDecoder().decode(bytes.subarray(5, 5 + streamLen))
  const payload = bytes.subarray(5 + streamLen)
  return { kind, streamId, final, payload }
}

export function verifyNonRelayCandidatePair(stats: RTCStatsReport): DirectCandidateInfo {
  const entries = new Map<string, Record<string, unknown>>()
  stats.forEach((value, key) => {
    entries.set(key, value as unknown as Record<string, unknown>)
  })

  let pair: Record<string, unknown> | undefined
  for (const record of entries.values()) {
    if (record.type === 'transport' && typeof record.selectedCandidatePairId === 'string') {
      pair = entries.get(record.selectedCandidatePairId)
      if (pair) break
    }
  }
  if (!pair) {
    for (const record of entries.values()) {
      if (record.type === 'candidate-pair' && record.state === 'succeeded' && (record.nominated || record.selected)) {
        pair = record
        break
      }
    }
  }
  if (!pair) {
    throw new Error('No active ICE candidate pair established')
  }

  const localCand = typeof pair.localCandidateId === 'string' ? entries.get(pair.localCandidateId) : undefined
  const remoteCand = typeof pair.remoteCandidateId === 'string' ? entries.get(pair.remoteCandidateId) : undefined
  const localType = String(localCand?.candidateType || '').toLowerCase()
  const remoteType = String(remoteCand?.candidateType || '').toLowerCase()

  if (!DIRECT_CANDIDATE_TYPES.has(localType) || !DIRECT_CANDIDATE_TYPES.has(remoteType)) {
    throw new Error(`Direct P2P required: relay or unsupported candidate (${localType || 'unknown'} -> ${remoteType || 'unknown'})`)
  }
  const rtt = typeof pair.currentRoundTripTime === 'number'
    ? Math.max(0, Math.round(pair.currentRoundTripTime * 1000))
    : null
  return { localType, remoteType, rttMs: rtt }
}

const NON_PROXIED_STATIC_PATHS = new Set(['/favicon.ico', '/favicon.svg', '/manifest.webmanifest'])

export function normalizeDaemonPath(pathname: string): string {
  const stripped = pathname.replace(/^\/p2p\/[^/]+(?=\/|$)/, '')
  return stripped ? (stripped.startsWith('/') ? stripped : `/${stripped}`) : '/'
}

export function shouldProxyWebRtcHttp(rawUrl: string, baseHref?: string): boolean {
  if (/^(?:data|blob|javascript|mailto):/i.test(rawUrl.trim())) return false
  const fallbackOrigin = typeof window !== 'undefined' && window.location ? window.location.href : 'http://127.0.0.1/'
  const effectiveBase = baseHref || fallbackOrigin
  try {
    const base = new URL(effectiveBase)
    const resolved = new URL(rawUrl, base)
    if (resolved.origin !== base.origin) return false
    const daemonPath = normalizeDaemonPath(resolved.pathname)
    if (daemonPath === '/api/webrtc' || daemonPath.startsWith('/api/webrtc/')) return false
    if (daemonPath === '/assets' || daemonPath.startsWith('/assets/')) return false
    if (daemonPath === '/workspace-assets' || daemonPath.startsWith('/workspace-assets/')) return false
    if (NON_PROXIED_STATIC_PATHS.has(daemonPath)) return false
    return true
  } catch {
    return false
  }
}

interface PendingHttpStream {
  resolveResponse?: (response: Response) => void
  rejectResponse?: (err: Error) => void
  controller?: ReadableStreamDefaultController<Uint8Array>
  closed: boolean
}

export class DataChannelWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  readonly url: string
  readonly protocol = ''
  readonly extensions = ''
  readonly bufferedAmount = 0
  binaryType: BinaryType = 'blob'
  readyState: number = DataChannelWebSocket.CONNECTING

  onopen: ((ev: Event) => unknown) | null = null
  onmessage: ((ev: MessageEvent) => unknown) | null = null
  onerror: ((ev: Event) => unknown) | null = null
  onclose: ((ev: CloseEvent) => unknown) | null = null

  private readonly _sendData: (data: string | ArrayBuffer | ArrayBufferView) => void
  private readonly _closeStream: (code: number) => void
  private _textParts: Uint8Array[] = []
  private _binParts: Uint8Array[] = []

  constructor(
    url: string,
    sendData: (data: string | ArrayBuffer | ArrayBufferView) => void,
    closeStream: (code: number) => void,
  ) {
    super()
    this.url = url
    this._sendData = sendData
    this._closeStream = closeStream
  }

  _handleOpen(accepted: boolean): void {
    if (!accepted) {
      this.readyState = DataChannelWebSocket.CLOSED
      const errEvent = new Event('error')
      this.onerror?.(errEvent)
      this.dispatchEvent(errEvent)
      this._emitClose(1006)
      return
    }
    if (this.readyState !== DataChannelWebSocket.CONNECTING) return
    this.readyState = DataChannelWebSocket.OPEN
    const ev = new Event('open')
    this.onopen?.(ev)
    this.dispatchEvent(ev)
  }

  _handleBinaryChunk(kind: WebRtcBinaryKind, chunk: Uint8Array, final: boolean): void {
    if (this.readyState !== DataChannelWebSocket.OPEN) return
    if (kind === WebRtcBinaryKind.websocketDataText) {
      this._textParts.push(new Uint8Array(chunk))
      if (!final) return
      const merged = concatBytes(this._textParts)
      this._textParts = []
      const text = new TextDecoder().decode(merged)
      const ev = new MessageEvent('message', { data: text })
      this.onmessage?.(ev)
      this.dispatchEvent(ev)
      return
    }
    this._binParts.push(new Uint8Array(chunk))
    if (!final) return
    const merged = concatBytes(this._binParts)
    this._binParts = []
    const payload = this.binaryType === 'arraybuffer' ? merged.buffer : new Blob([merged])
    const ev = new MessageEvent('message', { data: payload })
    this.onmessage?.(ev)
    this.dispatchEvent(ev)
  }

  _emitClose(code = 1000): void {
    if (this.readyState === DataChannelWebSocket.CLOSED) return
    this.readyState = DataChannelWebSocket.CLOSED
    const ev = typeof CloseEvent !== 'undefined'
      ? new CloseEvent('close', { code, wasClean: code === 1000 })
      : (Object.assign(new Event('close'), { code, wasClean: code === 1000 }) as unknown as CloseEvent)
    this.onclose?.(ev)
    this.dispatchEvent(ev)
  }

  send(data: string | ArrayBuffer | Blob | ArrayBufferView): void {
    if (this.readyState !== DataChannelWebSocket.OPEN) {
      throw new Error('WebSocket is not open')
    }
    if (typeof data === 'string') {
      this._sendData(data)
      return
    }
    if (data instanceof Blob) {
      void data.arrayBuffer().then((buf) => {
        if (this.readyState === DataChannelWebSocket.OPEN) this._sendData(buf)
      })
      return
    }
    this._sendData(data)
  }

  close(code = 1000): void {
    if (this.readyState >= DataChannelWebSocket.CLOSING) return
    this.readyState = DataChannelWebSocket.CLOSING
    this._closeStream(code)
    this._emitClose(code)
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((acc, item) => acc + item.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function normalizeHeaders(input?: HeadersInit): [string, string][] {
  if (!input) return []
  const pairs: [string, string][] = []
  new Headers(input).forEach((value, key) => {
    pairs.push([key, value])
  })
  return pairs
}

async function serializeRequestBody(
  url: string,
  method: string,
  body: BodyInit | null | undefined,
  headers: [string, string][],
): Promise<{ bytes: Uint8Array | null; headers: [string, string][] }> {
  if (body == null) return { bytes: null, headers }
  if (typeof body === 'string') {
    return { bytes: new TextEncoder().encode(body), headers }
  }
  if (body instanceof ArrayBuffer) {
    return { bytes: new Uint8Array(body), headers }
  }
  if (ArrayBuffer.isView(body)) {
    return { bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength), headers }
  }
  if (body instanceof URLSearchParams) {
    return { bytes: new TextEncoder().encode(body.toString()), headers }
  }
  if (body instanceof Blob) {
    return { bytes: new Uint8Array(await body.arrayBuffer()), headers }
  }
  // FormData or ReadableStream: let native Request encode multipart boundaries cleanly.
  const req = new Request(url, { method, body })
  const nextHeaders = [...headers]
  const contentType = req.headers.get('content-type')
  if (contentType && !nextHeaders.some(([k]) => k.toLowerCase() === 'content-type')) {
    nextHeaders.push(['content-type', contentType])
  }
  const buf = await req.arrayBuffer()
  return { bytes: new Uint8Array(buf), headers: nextHeaders }
}

export class WebRtcTransportClient {
  readonly channel: DataChannelLike
  private _seq = 0
  private _closed = false
  private _authPending: {
    resolve: (ready: { device_id: string; candidate_info?: Record<string, unknown> }) => void
    reject: (err: Error) => void
  } | null = null
  private _pingPending = new Map<string, {
    startedAt: number
    resolve: (latencyMs: number) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private _httpStreams = new Map<string, PendingHttpStream>()
  private _wsStreams = new Map<string, DataChannelWebSocket>()

  constructor(channel: DataChannelLike) {
    this.channel = channel
    this.channel.binaryType = 'arraybuffer'
    this.channel.onmessage = (event: MessageEvent) => this._onMessage(event.data)
    this.channel.onclose = () => this.close()
    this.channel.onerror = () => this.close()
  }

  get isOpen(): boolean {
    return !this._closed && this.channel.readyState === 'open'
  }

  authenticate(ticket: string, pairKey: string, timeoutMs = 10000): Promise<{ device_id: string; candidate_info?: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      if (!this.isOpen) {
        reject(new Error('DataChannel is not open'))
        return
      }
      const timer = setTimeout(() => {
        if (this._authPending) {
          this._authPending = null
          reject(new Error('WebRTC authentication timed out'))
        }
      }, timeoutMs)
      this._authPending = {
        resolve: (data) => { clearTimeout(timer); resolve(data) },
        reject: (err) => { clearTimeout(timer); reject(err) },
      }
      this.channel.send(JSON.stringify({ type: 'p2p.auth', ticket, pair_key: pairKey }))
    })
  }

  ping(timeoutMs = 3000): Promise<number> {
    return new Promise((resolve, reject) => {
      if (!this.isOpen) {
        reject(new Error('DataChannel is not open'))
        return
      }
      const nonce = `ping-${this._nextStreamId()}`
      const startedAt = typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now()
      const timer = setTimeout(() => {
        if (this._pingPending.delete(nonce)) {
          reject(new Error('WebRTC ping timed out'))
        }
      }, timeoutMs)
      this._pingPending.set(nonce, { startedAt, resolve, reject, timer })
      try {
        this.channel.send(JSON.stringify({ type: 'p2p.ping', nonce }))
      } catch (err) {
        clearTimeout(timer)
        this._pingPending.delete(nonce)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private _nextStreamId(): string {
    this._seq += 1
    return `s-${this._seq}`
  }

  private _onMessage(raw: unknown): void {
    if (typeof raw === 'string') {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw) as Record<string, unknown>
      } catch {
        return
      }
      if (msg.type === 'p2p.ready' && this._authPending) {
        const pending = this._authPending
        this._authPending = null
        pending.resolve({
          device_id: String(msg.device_id || ''),
          candidate_info: (msg.candidate_info as Record<string, unknown> | undefined),
        })
        return
      }
      if (msg.type === 'p2p.error' && this._authPending) {
        const pending = this._authPending
        this._authPending = null
        pending.reject(new Error(String(msg.message || 'WebRTC authentication failed')))
        return
      }
      if (msg.type === 'p2p.pong') {
        const nonce = typeof msg.nonce === 'string' ? msg.nonce : ''
        const pending = nonce ? this._pingPending.get(nonce) : undefined
        if (pending) {
          clearTimeout(pending.timer)
          this._pingPending.delete(nonce)
          const endedAt = typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now()
          pending.resolve(Math.max(0, Math.round(endedAt - pending.startedAt)))
        }
        return
      }

      const frame = msg as unknown as ProxyFramePayload
      this._handleProxyFrame(frame)
      return
    }

    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      const view = raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
      const decoded = decodeBinaryFrame(view)
      if (decoded.kind === WebRtcBinaryKind.httpResponseBody) {
        const stream = this._httpStreams.get(decoded.streamId)
        if (!stream || stream.closed) return
        if (decoded.payload.byteLength > 0) {
          stream.controller?.enqueue(new Uint8Array(decoded.payload))
        }
        if (this.isOpen) {
          this.channel.send(JSON.stringify({
            stream_id: decoded.streamId,
            type: 'window.update',
            payload: { credits: 1 },
          }))
        }
      } else if (
        decoded.kind === WebRtcBinaryKind.websocketDataBytes
        || decoded.kind === WebRtcBinaryKind.websocketDataText
      ) {
        const ws = this._wsStreams.get(decoded.streamId)
        if (!ws) return
        ws._handleBinaryChunk(decoded.kind, decoded.payload, decoded.final)
        if (this.isOpen) {
          this.channel.send(JSON.stringify({
            stream_id: decoded.streamId,
            type: 'window.update',
            payload: { credits: 1 },
          }))
        }
      }
    }
  }

  private _handleProxyFrame(frame: ProxyFramePayload): void {
    const streamId = frame.stream_id
    if (!streamId) return
    if (frame.type === 'http.response') {
      const stream = this._httpStreams.get(streamId)
      if (!stream) return
      const phase = frame.payload?.phase
      if (phase === 'start') {
        const status = Number(frame.payload.status || 200)
        const rawHeaders = Array.isArray(frame.payload.headers) ? frame.payload.headers : []
        const headers = new Headers()
        for (const pair of rawHeaders) {
          if (Array.isArray(pair) && pair.length === 2) {
            try { headers.append(String(pair[0]), String(pair[1])) } catch { /* ignore invalid */ }
          }
        }
        const bodyStream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            stream.controller = controller
          },
          cancel: () => {
            stream.closed = true
            this._httpStreams.delete(streamId)
            if (this.isOpen) {
              this.channel.send(JSON.stringify({ stream_id: streamId, type: 'cancel', payload: {} }))
            }
          },
        })
        const resolve = stream.resolveResponse
        stream.resolveResponse = undefined
        stream.rejectResponse = undefined
        resolve?.(new Response(status === 204 || status === 304 ? null : bodyStream, { status, headers }))
      } else if (phase === 'end') {
        stream.closed = true
        this._httpStreams.delete(streamId)
        try { stream.controller?.close() } catch { /* already closed */ }
      } else if (phase === 'error') {
        stream.closed = true
        this._httpStreams.delete(streamId)
        const err = new Error('WebRTC upstream stream error')
        if (stream.rejectResponse) {
          stream.rejectResponse(err)
          stream.rejectResponse = undefined
        } else {
          try { stream.controller?.error(err) } catch { /* ignore */ }
        }
      }
      return
    }

    if (frame.type === 'websocket.open') {
      const ws = this._wsStreams.get(streamId)
      if (!ws) return
      const accepted = Boolean(frame.payload?.accepted)
      ws._handleOpen(accepted)
      if (!accepted) this._wsStreams.delete(streamId)
    } else if (frame.type === 'websocket.close') {
      const ws = this._wsStreams.get(streamId)
      if (!ws) return
      this._wsStreams.delete(streamId)
      ws._emitClose(Number(frame.payload?.code || 1000))
    }
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (!this.isOpen) {
      throw new TypeError('WebRTC P2P DataChannel is disconnected')
    }
    const baseHref = typeof window !== 'undefined' && window.location ? window.location.href : 'http://127.0.0.1/'
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const parsed = new URL(rawUrl, baseHref)
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const baseHeaders = normalizeHeaders(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const rawBody = init?.body ?? (input instanceof Request && method !== 'GET' && method !== 'HEAD' ? await input.clone().arrayBuffer() : null)
    const { bytes, headers } = await serializeRequestBody(parsed.href, method, rawBody, baseHeaders)

    const streamId = this._nextStreamId()
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)

    return new Promise<Response>((resolve, reject) => {
      const pending: PendingHttpStream = {
        resolveResponse: resolve,
        rejectResponse: reject,
        closed: false,
      }
      this._httpStreams.set(streamId, pending)

      const onAbort = () => {
        pending.closed = true
        this._httpStreams.delete(streamId)
        if (this.isOpen) {
          this.channel.send(JSON.stringify({ stream_id: streamId, type: 'cancel', payload: {} }))
        }
        const abortErr = new DOMException('The operation was aborted.', 'AbortError')
        if (pending.rejectResponse) {
          pending.rejectResponse(abortErr)
          pending.rejectResponse = undefined
        } else {
          try { pending.controller?.error(abortErr) } catch { /* ignore */ }
        }
      }

      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      try {
        this.channel.send(JSON.stringify({
          stream_id: streamId,
          type: 'http.request',
          payload: {
            phase: 'start',
            method,
            path: normalizeDaemonPath(parsed.pathname),
            query: parsed.search.startsWith('?') ? parsed.search.slice(1) : '',
            headers,
          },
        }))

        if (!bytes || bytes.byteLength === 0) {
          this.channel.send(JSON.stringify({
            stream_id: streamId,
            type: 'http.request',
            payload: { phase: 'end' },
          }))
        } else {
          for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
            const chunk = bytes.subarray(offset, offset + CHUNK_BYTES)
            const final = offset + CHUNK_BYTES >= bytes.byteLength
            this.channel.send(encodeBinaryFrame(WebRtcBinaryKind.httpRequestBody, streamId, chunk, final))
          }
        }
      } catch (err) {
        this._httpStreams.delete(streamId)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  createWebSocket(url: string): DataChannelWebSocket {
    const baseHref = typeof window !== 'undefined' && window.location ? window.location.href : 'http://127.0.0.1/'
    const parsed = new URL(url, baseHref)
    const streamId = this._nextStreamId()

    const ws = new DataChannelWebSocket(
      parsed.toString(),
      (data) => {
        if (!this.isOpen) throw new Error('WebRTC DataChannel closed')
        if (typeof data === 'string') {
          const encoded = new TextEncoder().encode(data)
          if (encoded.byteLength === 0) {
            this.channel.send(encodeBinaryFrame(WebRtcBinaryKind.websocketDataText, streamId, encoded, true))
          } else {
            for (let off = 0; off < encoded.byteLength; off += CHUNK_BYTES) {
              const chunk = encoded.subarray(off, off + CHUNK_BYTES)
              this.channel.send(encodeBinaryFrame(
                WebRtcBinaryKind.websocketDataText,
                streamId,
                chunk,
                off + CHUNK_BYTES >= encoded.byteLength,
              ))
            }
          }
          return
        }
        const bytes = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        if (bytes.byteLength === 0) {
          this.channel.send(encodeBinaryFrame(WebRtcBinaryKind.websocketDataBytes, streamId, bytes, true))
        } else {
          for (let off = 0; off < bytes.byteLength; off += CHUNK_BYTES) {
            const chunk = bytes.subarray(off, off + CHUNK_BYTES)
            this.channel.send(encodeBinaryFrame(
              WebRtcBinaryKind.websocketDataBytes,
              streamId,
              chunk,
              off + CHUNK_BYTES >= bytes.byteLength,
            ))
          }
        }
      },
      (code) => {
        this._wsStreams.delete(streamId)
        if (this.isOpen) {
          this.channel.send(JSON.stringify({ stream_id: streamId, type: 'websocket.close', payload: { code } }))
        }
      },
    )

    this._wsStreams.set(streamId, ws)
    if (!this.isOpen) {
      queueMicrotask(() => ws._handleOpen(false))
      return ws
    }
    this.channel.send(JSON.stringify({
      stream_id: streamId,
      type: 'websocket.open',
      payload: {
        path: normalizeDaemonPath(parsed.pathname),
        query: parsed.search.startsWith('?') ? parsed.search.slice(1) : '',
        headers: [],
      },
    }))
    return ws
  }

  close(): void {
    if (this._closed) return
    this._closed = true
    if (this._authPending) {
      this._authPending.reject(new Error('WebRTC DataChannel closed'))
      this._authPending = null
    }
    for (const pending of this._pingPending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('WebRTC DataChannel closed'))
    }
    this._pingPending.clear()
    for (const stream of this._httpStreams.values()) {
      stream.closed = true
      stream.rejectResponse?.(new TypeError('WebRTC DataChannel closed'))
      try { stream.controller?.error(new TypeError('WebRTC DataChannel closed')) } catch { /* ignore */ }
    }
    this._httpStreams.clear()
    for (const ws of this._wsStreams.values()) {
      ws._emitClose(1006)
    }
    this._wsStreams.clear()
    try { this.channel.close() } catch { /* ignore */ }
  }
}

export function installGlobalWebRtcTransport(transport: WebRtcTransportClient): () => void {
  const originalFetch = globalThis.fetch
  const OriginalWebSocket = globalThis.WebSocket

  const shouldProxyHttp = (rawUrl: string): boolean => shouldProxyWebRtcHttp(rawUrl)

  const shouldProxyWs = (rawUrl: string): boolean => {
    try {
      const resolved = new URL(rawUrl, window.location.href)
      if (resolved.host !== window.location.host) return false
      const daemonPath = normalizeDaemonPath(resolved.pathname)
      return daemonPath !== '/ws/webrtc' && !daemonPath.startsWith('/ws/webrtc/')
    } catch {
      return false
    }
  }

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (shouldProxyHttp(url)) {
      return transport.fetch(input, init)
    }
    return originalFetch.call(globalThis, input, init)
  }) as typeof fetch

  globalThis.WebSocket = class ProxiedWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const target = typeof url === 'string' ? url : url.toString()
      if (shouldProxyWs(target)) {
        return transport.createWebSocket(target) as unknown as WebSocket
      }
      return protocols === undefined ? new OriginalWebSocket(target) : new OriginalWebSocket(target, protocols)
    }
    static readonly CONNECTING = OriginalWebSocket.CONNECTING
    static readonly OPEN = OriginalWebSocket.OPEN
    static readonly CLOSING = OriginalWebSocket.CLOSING
    static readonly CLOSED = OriginalWebSocket.CLOSED
  } as unknown as typeof WebSocket

  return () => {
    globalThis.fetch = originalFetch
    globalThis.WebSocket = OriginalWebSocket
  }
}
