import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { captureVoice } from '../src/utils/voiceCapture'
import { openVoiceDsp } from '../src/audio/voiceDsp'

test('cold voice detection can buffer a slow model load, with a smaller limit after it catches up', async () => {
  const { window } = installDomEnvironment()
  const original = globalThis.Worker
  const ports: MessagePort[] = []
  globalThis.Worker = class extends EventTarget {
    postMessage({ port }: { port: MessagePort }) { ports.push(port) }
    terminate() {}
  } as unknown as typeof Worker
  const rate = 16000
  let failures = 0, received!: () => void
  const processed = new Promise<void>(resolve => { received = resolve })
  const dsp = openVoiceDsp(rate, received, () => { failures++ }, true)
  try {
    for (let second = 0; second < 6; second++) dsp.push(new Float32Array(rate))
    assert.equal(failures, 0, 'the first model download can exceed five seconds')
    ports[0].postMessage({ type: 'pcm', pcm: new Int16Array(), captured: rate * 6 })
    await processed
    for (let second = 0; second < 6; second++) dsp.push(new Float32Array(rate))
    assert.equal(failures, 1, 'a stalled active detector still fails after five seconds of queued audio')
    dsp.push(new Float32Array(rate))
    assert.equal(failures, 1)
    const cold = openVoiceDsp(rate, () => {}, () => { failures++ })
    for (let second = 0; second < 16; second++) cold.push(new Float32Array(rate))
    assert.equal(failures, 2, 'the startup queue remains bounded')
  } finally {
    dsp.close()
    for (const port of ports) port.close()
    globalThis.Worker = original
    await window.happyDOM.close()
  }
})

for (const scenario of ['fallback', 'permission', 'aborted', 'unavailable'] as const) {
  test(`microphone acquisition handles ${scenario} without leaking audio`, async () => {
    const { window } = installDomEnvironment()
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    const original = globalThis.AudioContext
    const controller = new AbortController()
    const requests: MediaStreamConstraints[] = []
    let stopped = 0, closed = 0
    const track = { stop() { stopped++ } }
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
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
      await assert.rejects(captureVoice(() => {}, controller.signal), scenario === 'fallback' ? /speech.audioCaptureFailed/
        : scenario === 'permission' ? /Denied/ : scenario === 'aborted' ? /Cancelled/ : /speech.audioSourceUnavailable/)
      assert.equal(requests.length, scenario === 'aborted' ? 0 : scenario === 'permission' ? 1 : 2)
      if(requests.length)assert.equal((requests[0].audio as MediaTrackConstraints).autoGainControl,false)
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
    getUserMedia: async () => { requests++; resume(); return { getTracks: () => [], getAudioTracks: () => [] } },
  } })
  const pending = captureVoice(() => {}, controller.signal)
  void pending.catch(() => {})
  try {
    await Promise.resolve(); await Promise.resolve()
    assert.equal(requests, 1, 'capture must unlock Web Audio instead of waiting on it')
    await assert.rejects(pending, /speech.audioCaptureFailed/)
  } finally {
    controller.abort(); resume(); await pending.catch(() => {})
    globalThis.AudioContext = original; await window.happyDOM.close()
  }
})

test('rapid capture toggles reuse the audio graph and release each microphone track', async t => {
  const { window } = installDomEnvironment()
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  const originalContext = globalThis.AudioContext, originalNode = globalThis.AudioWorkletNode
  let contexts = 0, modules = 0, tracks = 0, stopped = 0, suspended = 0, closed = 0
  const first = new AbortController(), second = new AbortController()
  class Context {
    sampleRate = 48000
    constructor() { contexts++ }
    async resume() {}
    async suspend() { suspended++ }
    async close() { closed++ }
    audioWorklet = { addModule: async () => { modules++ } }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
  }
  class Node {
    port = { onmessage: null }
    connect() {}
    disconnect() {}
  }
  globalThis.AudioContext = Context as unknown as typeof AudioContext
  globalThis.AudioWorkletNode = Node as unknown as typeof AudioWorkletNode
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    async getUserMedia() {
      tracks++
      const track = { stop: () => { stopped++ } }
      return { getTracks: () => [track], getAudioTracks: () => [track] }
    },
  } })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await captureVoice(() => {}, first.signal, false, 1280, { reuseContext: true })
    first.abort()
    assert.equal(stopped, 1)
    await captureVoice(() => {}, second.signal, false, 1280, { reuseContext: true })
    assert.deepEqual({contexts, modules, tracks, stopped, suspended, closed},
      {contexts: 1, modules: 1, tracks: 2, stopped: 1, suspended: 0, closed: 0})
    second.abort()
    assert.equal(stopped, 2)
    await Promise.resolve()
    assert.equal(suspended, 1)
    t.mock.timers.tick(2000)
    assert.equal(closed, 1)
    const third = await captureVoice(() => {}, new AbortController().signal, false, 1280, { reuseContext: true })
    third.stop()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new window.Event('visibilitychange'))
    assert.equal(closed, 2, 'idle context closes before background timers are frozen')
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    const fourth = await captureVoice(() => {}, new AbortController().signal, false, 1280, { reuseContext: true })
    try { assert.equal(contexts, 3, 'foreground capture gets a fresh graph') }
    finally { fourth.stop() }
  } finally {
    first.abort(); second.abort()
    t.mock.timers.tick(2000)
    t.mock.timers.reset()
    globalThis.AudioContext = originalContext
    globalThis.AudioWorkletNode = originalNode
    await window.happyDOM.close()
  }
})
