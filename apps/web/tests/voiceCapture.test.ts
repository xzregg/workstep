import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { captureVoice } from '../src/utils/voiceCapture'

for (const scenario of ['fallback', 'permission', 'aborted', 'unavailable'] as const) {
  test(`microphone acquisition handles ${scenario} without leaking audio`, async () => {
    const { window } = installDomEnvironment()
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    const original = globalThis.AudioContext
    const controller = new AbortController()
    const requests: MediaStreamConstraints[] = []
    let stopped = 0, closed = 0
    const stream = { getTracks: () => [{ stop() { stopped++ } }] } as unknown as MediaStream
    class Context {
      resume() { if (scenario === 'aborted') controller.abort(); return Promise.resolve() }
      close() { closed++; return Promise.resolve() }
      audioWorklet = { addModule: async () => { throw new Error('graph reached') } }
    }
    globalThis.AudioContext = Context as unknown as typeof AudioContext
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        requests.push(constraints)
        if (scenario === 'permission') throw new DOMException('Denied', 'NotAllowedError')
        if (scenario === 'unavailable' || requests.length === 1) throw new DOMException('Could not start audio source', 'NotReadableError')
        return stream
      },
    } })
    try {
      await assert.rejects(captureVoice(() => {}, controller.signal), scenario === 'fallback' ? /graph reached/
        : scenario === 'permission' ? /Denied/ : scenario === 'aborted' ? /Cancelled/ : /speech.audioSourceUnavailable/)
      assert.equal(requests.length, scenario === 'aborted' ? 0 : scenario === 'permission' ? 1 : 2)
      if (scenario === 'fallback') {
        assert.deepEqual(requests[1], { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
        assert.equal(stopped, 1)
      }
      assert.equal(closed, 1)
    } finally { globalThis.AudioContext = original; await window.happyDOM.close() }
  })
}

test('capture emits half-second audio frames instead of waiting for a full second', async () => {
  const { window } = installDomEnvironment()
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  const originalContext = globalThis.AudioContext
  const originalNode = globalThis.AudioWorkletNode
  const frames: number[] = []
  let processor!: { port: { onmessage: ((event: MessageEvent<Float32Array>) => void) | null } }
  class Context {
    sampleRate = 48000
    resume() { return Promise.resolve() }
    close() { return Promise.resolve() }
    audioWorklet = { addModule: async () => {} }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
  }
  class Node {
    port = { onmessage: null as ((event: MessageEvent<Float32Array>) => void) | null }
    constructor() { processor = this }
    connect() {} disconnect() {}
  }
  globalThis.AudioContext = Context as unknown as typeof AudioContext
  globalThis.AudioWorkletNode = Node as unknown as typeof AudioWorkletNode
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [] }),
  } })
  let capture: Awaited<ReturnType<typeof captureVoice>> | undefined
  try {
    capture = await captureVoice(samples => frames.push(samples.length), new AbortController().signal)
    processor.port.onmessage!({ data: new Float32Array(24000) } as MessageEvent<Float32Array>)
    assert.deepEqual(frames, [8000])
    processor.port.onmessage!({ data: new Float32Array(12000) } as MessageEvent<Float32Array>)
    capture.flush()
    assert.deepEqual(frames, [8000, 4000])
  } finally {
    capture?.stop(); globalThis.AudioContext = originalContext; globalThis.AudioWorkletNode = originalNode
    await window.happyDOM.close()
  }
})

test('microphone acquisition does not wait for a suspended audio context to resume first', async () => {
  const { window } = installDomEnvironment()
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  const original = globalThis.AudioContext
  const controller = new AbortController()
  let resume!: () => void
  let requests = 0, resumes = 0
  class Context {
    resume() {
      if (++resumes === 1) return new Promise<void>(done => { resume = done })
      return Promise.resolve()
    }
    close() { resume(); return Promise.resolve() }
    audioWorklet = { addModule: async () => { throw new Error('capture graph reached') } }
  }
  globalThis.AudioContext = Context as unknown as typeof AudioContext
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: async () => { requests++; resume(); return { getTracks: () => [] } },
  } })
  const pending = captureVoice(() => {}, controller.signal)
  void pending.catch(() => {})
  try {
    await Promise.resolve(); await Promise.resolve()
    assert.equal(requests, 1, 'capture must unlock Web Audio instead of waiting on it')
    await assert.rejects(pending, /capture graph reached/)
  } finally {
    controller.abort(); resume(); await pending.catch(() => {})
    globalThis.AudioContext = original; await window.happyDOM.close()
  }
})
