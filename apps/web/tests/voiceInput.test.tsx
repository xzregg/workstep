import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { useVoiceInput, VoiceprintNoticesContext } from '../src/hooks/useVoiceInput'
import { speechApi } from '../src/api/speech'
import { captureVoice, voiceCapture, VoiceResampler, pcmBase64 } from '../src/utils/voiceCapture'
import {TurnController} from '../src/audio/turnController'
import { I18nProvider } from '../src/i18n'
import ChatInput from '../src/components/ChatInput'

test('resampling preserves sample count across arbitrary audio frames and PCM is little endian', () => {
  const sampler = new VoiceResampler(48000)
  let count = 0
  for (let offset = 0; offset < 48000; offset += 128) count += sampler.push(new Float32Array(Math.min(128, 48000-offset)).fill(.5)).length
  assert.equal(count, 16000)
  assert.equal(pcmBase64(Int16Array.from([1, -32768, 32767])), 'AQAA gP9/'.replace(' ', ''))
})

test('site policy blocking is distinct from an Android or browser permission refusal', async () => {
  const { window } = installDomEnvironment()
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  let requested = false
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: () => { requested = true; return Promise.reject(new Error('must not request')) },
  } })
  Object.defineProperty(document, 'featurePolicy', { configurable: true, value: { allowsFeature: () => false } })
  try {
    await assert.rejects(captureVoice(() => {}, new AbortController().signal), /speech.pageMicrophoneBlocked/)
    assert.equal(requested, false)
  } finally { await window.happyDOM.close() }
})

test('finished dictation inserts once at the captured cursor; cancellation discards late results', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { start: speechApi.start, audio: speechApi.audio, cancel: speechApi.cancel, capture: voiceCapture.start }
  let chunk: (pcm: Int16Array, level: number) => void = () => {}
  let stopped = 0
  voiceCapture.start = async callback => { chunk = callback; return { stop: () => { stopped++ }, flush: () => {} } }
  speechApi.start = async () => ({ id: 'a'.repeat(32), sample_rate: 16000, max_seconds: 120 })
  speechApi.cancel = async () => ({ cancelled: true })
  const inserted: [string, number][] = []
  let state!: ReturnType<typeof useVoiceInput>
  let owner = 'a'
  let showLevel = false
  function Harness() {
    state = useVoiceInput({ ownerKey: owner, disabled: false, compact: false, projectId: 'p',
      value: '之前之后', cursor: 2, showLevel, onInsert: (text, cursor) => inserted.push([text, cursor]) })
    return null
  }
  try {
    speechApi.audio = async (id, _project, sequence, _audio, final) => ({ id, sequence, text: '粤语 English', final })
    await act(async () => root.render(<Harness />))
    await act(async () => state.start())
    assert.equal(state.phase, 'recording')
    await act(async () => chunk(new Int16Array(16000), .5))
    assert.equal(state.text, '粤语 English')
    assert.equal(state.level, 0, 'a hidden meter does not publish audio levels')
    showLevel = true
    await act(async () => root.render(<Harness />))
    await act(async () => chunk(new Int16Array(16000), .5))
    assert.equal(state.level, .5, 'showing the meter resumes level updates during capture')
    await act(async () => state.finish())
    assert.deepEqual(inserted, [['粤语 English', 2]])
    assert.equal(state.active, false)
    let resolve!: (value: Awaited<ReturnType<typeof speechApi.audio>>) => void
    speechApi.audio = () => new Promise(done => { resolve = done })
    await act(async () => state.start())
    await act(async () => chunk(new Int16Array(16000), .5))
    owner = 'b'
    await act(async () => root.render(<Harness />))
    await act(async () => resolve({ id: 'a'.repeat(32), sequence: 0, text: '不能串入', final: true }))
    assert.equal(inserted.length, 1)
    assert.ok(stopped >= 2)
  } finally {
    speechApi.start = original.start; speechApi.audio = original.audio; speechApi.cancel = original.cancel
    voiceCapture.start = original.capture
    await act(async () => root.unmount()); await window.happyDOM.close()
  }
})

test('microphone does not send a message or change the agent stop action', async () => {
  const originalStatus = speechApi.status
  speechApi.status = async () => ({ enabled: true } as Awaited<ReturnType<typeof speechApi.status>>)
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = voiceCapture.start
  voiceCapture.start = async () => { throw new Error('speech.secureRequired') }
  let sent = 0, stopped = 0
  try {
    await act(async () => root.render(<I18nProvider><ChatInput value="已有草稿" onChange={() => {}} onSend={() => { sent++ }} /></I18nProvider>))
    assert.ok(document.querySelector('.voice-microphone'))
    await act(async () => (document.querySelector('.voice-microphone') as HTMLButtonElement).click())
    assert.equal(sent, 0)
    assert.match(document.body.textContent!, /HTTPS/)
    await act(async () => root.render(<I18nProvider><ChatInput value="" running onStop={() => { stopped++ }} onChange={() => {}} onSend={() => { sent++ }} /></I18nProvider>))
    assert.equal((document.querySelector('.voice-microphone') as HTMLButtonElement).disabled, true)
    await act(async () => (document.querySelector('.chat-input-send') as HTMLButtonElement).click())
    assert.equal(stopped, 1)
  } finally {
    voiceCapture.start = original; speechApi.status = originalStatus
    await act(async () => root.unmount()); await window.happyDOM.close()
  }
})

test('mobile long press starts recording with existing text and scrolling cancels the gesture', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  let state!: ReturnType<typeof useVoiceInput>
  let value = ''
  const original = { capture: voiceCapture.start, start: speechApi.start, cancel: speechApi.cancel }
  let captures = 0
  voiceCapture.start = async () => { captures++; return { stop() {}, flush() {} } }
  speechApi.start = async () => ({ id: 'a'.repeat(32), sample_rate: 16000, max_seconds: 120 })
  speechApi.cancel = async () => ({ cancelled: true })
  function Harness() {
    state = useVoiceInput({ ownerKey: 'mobile', disabled: false, compact: true, value, cursor: 0, onInsert: () => {} })
    return <div className="target" {...state.pointer} />
  }
  const event = (x = 0) => ({ pointerType: 'touch', clientX: x, clientY: 0, preventDefault: () => {} }) as Parameters<typeof state.pointer.onPointerDown>[0]
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => { state.pointer.onPointerDown(event()); state.pointer.onPointerMove(event(20)); await new Promise(r => setTimeout(r, 530)) })
    assert.equal(state.mode, false)
    assert.equal(captures, 0)
    await act(async () => { state.pointer.onPointerDown(event()); await new Promise(r => setTimeout(r, 530)) })
    assert.equal(state.mode, true)
    assert.equal(state.phase, 'recording')
    assert.equal(captures, 1)
    await act(async () => { state.cancel(); state.setMode(false) })
    value = '保留长按复制'
    await act(async () => root.render(<Harness />))
    await act(async () => { state.pointer.onPointerDown(event()); await new Promise(r => setTimeout(r, 530)) })
    assert.equal(state.mode, true)
    assert.equal(state.phase, 'recording')
    assert.equal(captures, 2)
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    voiceCapture.start = original.capture; speechApi.start = original.start; speechApi.cancel = original.cancel
  }
})

for (const width of [320, 390, 1023, 1440]) {
  test(`composer previews successive paused phrases and inserts once at ${width}px`, async () => {
    const { window } = installDomEnvironment()
    window.happyDOM.setWindowSize({ width })
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    const changes: string[] = []
    let sent = 0
    const originalStatus = speechApi.status
    speechApi.status = async () => ({ enabled: true } as Awaited<ReturnType<typeof speechApi.status>>)
    const original = { capture: voiceCapture.start, start: speechApi.start, cancel: speechApi.cancel }
    let turn = new TurnController()
    let end = 0
    let chunk!: Parameters<typeof voiceCapture.start>[0]
    let started = 0
    let captures = 0
    let stopped = false
    let finishRecognition!: () => void
    voiceCapture.start = async (callback, _signal, detectSpeech, _frameSamples, options) => {
      assert.equal(detectSpeech, true)
      assert.equal(options?.continuous, true)
      captures++
      chunk = callback
      return { stop() { stopped = true }, flush: async () => turn.snapshot() }
    }
    const frames = (count: number, probability: number, level = 0) => {
      for (let i = 0; i < count; i++) turn.frame({ end: end += 512, probability })
      const state = turn.snapshot()
      chunk(new Int16Array(count * 512), level, state)
      if (state.canCommit) turn = new TurnController()
    }
    speechApi.start = async () => {
      started++
      return { id: String(started).repeat(32), sample_rate: 16000, max_seconds: 120,
        streaming: width === 1440 ? 'segment' : 'final' }
    }
    speechApi.cancel = async () => ({ cancelled: true })
    const originalAudio = speechApi.audio
    speechApi.audio = async (id, _project, sequence, _audio, final) => {
      assert.equal(final, true)
      await new Promise<void>(resolve => { finishRecognition = resolve })
      return { id, sequence, final, text: ['第一段。', '第二段。', '第三段。'][Number(id[0]) - 1] }
    }
    try {
      const render = (value: string) => root.render(<I18nProvider><ChatInput value={value} onChange={text => {
        changes.push(text)
        render(text)
      }} onSend={() => { sent++ }} /></I18nProvider>)
      await act(async () => render(''))
      const mobile = width <= 1023
      if (mobile) assert.ok(document.querySelector('.voice-microphone') === null)
      const input = document.querySelector('textarea')!
      const preview = () => document.querySelector('.voice-input-transcript')?.textContent
      const trigger = document.querySelector<HTMLButtonElement>(mobile ? '.chat-input-send' : '.voice-microphone')!
      await act(async () => trigger.click())
      assert.ok(document.querySelector('.voice-input'))
      assert.equal(document.querySelector('.chat-input-editor')?.getAttribute('data-voice-mode'), 'true')
      assert.deepEqual(changes, [])
      assert.ok(document.querySelector('textarea') === input)
      assert.equal(input.disabled, false, 'the touch target must remain enabled')
      assert.equal(input.readOnly, true, 'freeze editing without disabling the touch target')
      await act(async () => frames(20, .02))
      assert.equal(started, 0)
      if (mobile) {
        const meter = document.querySelector('.voice-input-waveform')
        assert.equal(preview(), '', 'reserve the transcript area before recognition returns')
        assert.equal(meter?.getAttribute('aria-valuenow'), '0')
        assert.equal(meter?.hasAttribute('data-audible'), false)
        await act(async () => frames(2, .02, .65))
        assert.equal(meter?.getAttribute('aria-valuenow'), '0.65')
        assert.equal(meter?.hasAttribute('data-audible'), true)
        assert.equal(document.querySelector('.chat-input-frame')?.getAttribute('data-compact-voice'), 'true')
      }
      await act(async () => { frames(4, .9); frames(10, .02) })
      if (mobile) assert.equal(document.querySelector('.voice-input-waveform')?.hasAttribute('data-audible'), false)
      assert.equal(started, 1)
      assert.equal(stopped, false)
      assert.ok(Array.from(document.querySelectorAll('button')).some(button => button.textContent === '完成录音'))
      await act(async () => frames(9, .02))
      assert.equal(stopped, false)
      // The next phrase may arrive while the preceding ASR request is pending.
      await act(async () => { frames(4, .9); frames(20, .02) })
      assert.equal(started, 1)
      await act(async () => finishRecognition())
      assert.equal(preview(), '第一段。')
      assert.equal(input.value, '')
      assert.equal(started, 2)
      await act(async () => finishRecognition())
      assert.equal(preview(), '第一段。第二段。')
      assert.equal(input.value, '')
      assert.deepEqual(changes, [])
      assert.equal(input.readOnly, true)
      await act(async () => frames(4, .9))
      await act(async () => Array.from(document.querySelectorAll('button')).find(button => button.textContent === '完成录音')!.click())
      assert.equal(stopped, true)
      assert.equal(input.readOnly, true)
      assert.equal(preview(), '第一段。第二段。')
      assert.equal(input.value, '')
      await act(async () => finishRecognition())
      assert.equal(input.value, '第一段。第二段。第三段。')
      assert.deepEqual(changes, ['第一段。第二段。第三段。'])
      assert.equal(preview(), undefined)
      assert.equal(input.readOnly, false)
      assert.equal(captures, 1)
      assert.equal(sent, 0)
    } finally {
      await act(async () => root.unmount()); await window.happyDOM.close()
      voiceCapture.start = original.capture; speechApi.start = original.start; speechApi.cancel = original.cancel; speechApi.audio = originalAudio; speechApi.status = originalStatus
    }
  })
}


test('releasing during microphone permission cancels late capture and restores the editor', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { capture: voiceCapture.start, start: speechApi.start }
  let resolve!: (capture: Awaited<ReturnType<typeof voiceCapture.start>>) => void
  let stopped = 0, sessions = 0
  voiceCapture.start = () => new Promise(done => { resolve = done })
  speechApi.start = async () => { sessions++; return { id: 'a'.repeat(32), sample_rate: 16000, max_seconds: 120 } }
  let state!: ReturnType<typeof useVoiceInput>
  function Harness() {
    state = useVoiceInput({ ownerKey: 'mobile', disabled: false, compact: true, value: '草稿', cursor: 2, onInsert: () => assert.fail('must not insert') })
    return null
  }
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => {
      state.pointer.onPointerDown({ pointerType: 'touch', clientX: 0, clientY: 0 } as Parameters<typeof state.pointer.onPointerDown>[0])
      await new Promise(done => setTimeout(done, 530))
    })
    assert.equal(state.phase, 'requesting')
    await act(async () => window.dispatchEvent(new window.PointerEvent('pointerup', { pointerType: 'touch' })))
    assert.equal(state.mode, false)
    assert.equal(state.phase, 'idle')
    await act(async () => resolve({ stop: () => { stopped++ }, flush() {} }))
    assert.equal(stopped, 1)
    assert.equal(sessions, 0)
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    voiceCapture.start = original.capture; speechApi.start = original.start
  }
})

test('dictation buffers preparation audio, coalesces queued chunks, and revises the live preview on finish', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { capture: voiceCapture.start, start: speechApi.start, audio: speechApi.audio, cancel: speechApi.cancel }
  let chunk!: (samples: Int16Array, volume: number) => void
  let ready!: (session: Awaited<ReturnType<typeof speechApi.start>>) => void
  let reply!: (result: Awaited<ReturnType<typeof speechApi.audio>>) => void
  const frames: { samples: number; final: boolean }[] = []
  const inserted: string[] = []
  voiceCapture.start = async callback => { chunk = callback; return { stop() {}, flush() {} } }
  speechApi.start = () => new Promise(done => { ready = done })
  speechApi.cancel = async () => ({ cancelled: true })
  speechApi.audio = async (id, project, sequence, audio, final) => {
    frames.push({ samples: atob(audio).length / 2, final })
    if (frames.length === 1) return new Promise(done => { reply = done })
    return { id, sequence, text: '最终修正词。', final }
  }
  let state!: ReturnType<typeof useVoiceInput>
  function Harness() {
    state = useVoiceInput({ ownerKey: 'stream', disabled: false, compact: false, value: '原草稿', cursor: 3, onInsert: text => inserted.push(text) })
    return null
  }
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => { void state.start() })
    await act(async () => { chunk(new Int16Array(8000), .4); chunk(new Int16Array(8000), .4) })
    assert.equal(frames.length, 0)
    await act(async () => ready({ id: 'a'.repeat(32), sample_rate: 16000, max_seconds: 120 }))
    assert.deepEqual(frames, [{ samples: 16000, final: false }])
    await act(async () => { chunk(new Int16Array(8000), .4); chunk(new Int16Array(8000), .4) })
    await act(async () => reply({ id: 'a'.repeat(32), sequence: 0, text: '临时词', final: false }))
    assert.equal(state.text, '最终修正词。')
    assert.equal(inserted.length, 0)
    await act(async () => state.finish())
    assert.deepEqual(frames.map(frame => frame.samples), [16000, 16000, 0])
    assert.deepEqual(inserted, ['最终修正词。'])
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    voiceCapture.start = original.capture; speechApi.start = original.start; speechApi.audio = original.audio; speechApi.cancel = original.cancel
  }
})

test('backgrounding cancels permission acquisition and releases a late stream before retry', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const originalContext = globalThis.AudioContext
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
  let requests = 0, stopped = 0, closed = 0
  let grant!: (stream: MediaStream) => void
  class Context {
    async resume() {}
    async close() { closed++ }
  }
  globalThis.AudioContext = Context as unknown as typeof AudioContext
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia() {
      if (++requests === 1) return new Promise<MediaStream>(resolve => { grant = resolve })
      return Promise.reject(new DOMException('Permission revoked', 'NotAllowedError'))
    },
  } })
  let state!: ReturnType<typeof useVoiceInput>
  function Harness() {
    state = useVoiceInput({ ownerKey: 'visibility', disabled: false, compact: false, automatic: true,
      value: '', cursor: 0, onInsert: () => assert.fail('late output') })
    return null
  }
  const visibility = (hidden: boolean) => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
    document.dispatchEvent(new window.Event('visibilitychange'))
  }
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => { void state.start(); void state.start() })
    assert.equal(state.phase, 'requesting')
    assert.equal(requests, 1)
    await act(async () => visibility(true))
    assert.equal(state.phase, 'idle')
    assert.equal(closed, 1)
    await act(async () => state.start())
    assert.equal(requests, 1)
    await act(async () => {
      grant({ getTracks: () => [{ stop() { stopped++ } }] } as unknown as MediaStream)
      visibility(false)
    })
    assert.equal(stopped, 1)
    assert.equal(requests, 1)
    await act(async () => state.start())
    assert.equal(state.error, 'speech.permissionDenied')
    assert.equal(requests, 2)
    assert.equal(closed, 2)
  } finally {
    await act(async () => root.unmount())
    globalThis.AudioContext = originalContext
    await window.happyDOM.close()
  }
})

for (const stage of ['microphone', 'service'] as const) {
  test(`${stage} preparation times out, permits retry, and discards late completion`, async context => {
    const { window } = installDomEnvironment()
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    const original = { capture: voiceCapture.start, start: speechApi.start, cancel: speechApi.cancel }
    let resolve!: (value: any) => void
    let stopped = 0
    const cancelled: string[] = []
    voiceCapture.start = stage === 'microphone' ? () => new Promise(done => { resolve = done })
      : async () => ({ stop() { stopped++ }, flush() {} })
    speechApi.start = stage === 'service' ? () => new Promise(done => { resolve = done })
      : async () => ({ id: 'new', sample_rate: 16000, max_seconds: 120 })
    speechApi.cancel = async id => { cancelled.push(id); return { cancelled: true } }
    let state!: ReturnType<typeof useVoiceInput>
    function Harness() {
      state = useVoiceInput({ ownerKey: 'timeout', disabled: false, compact: false, value: '', cursor: 0, onInsert: () => assert.fail('late output') })
      return null
    }
    try {
      await act(async () => root.render(<Harness />))
      context.mock.timers.enable({ apis: ['setTimeout'] })
      await act(async () => { void state.start() })
      assert.equal(state.phase, stage === 'microphone' ? 'requesting' : 'preparing')
      await act(async () => context.mock.timers.tick(30001))
      assert.equal(state.phase, 'error')
      assert.equal(state.error, stage === 'microphone' ? 'speech.microphoneTimeout' : 'speech.serviceTimeout')
      await act(async () => resolve(stage === 'microphone' ? { stop() { stopped++ }, flush() {} }
        : { id: 'late', sample_rate: 16000, max_seconds: 120 }))
      assert.equal(state.phase, 'error')
      if (stage === 'microphone') assert.equal(stopped, 1)
      else assert.deepEqual(cancelled, ['late'])
      voiceCapture.start = async () => ({ stop() {}, flush() {} })
      speechApi.start = async () => ({ id: 'retry', sample_rate: 16000, max_seconds: 120 })
      await act(async () => state.start())
      assert.equal(state.phase, 'recording')
      await act(async () => state.cancel())
    } finally {
      context.mock.timers.reset(); await act(async () => root.unmount()); await window.happyDOM.close()
      voiceCapture.start = original.capture; speechApi.start = original.start; speechApi.cancel = original.cancel
    }
  })
}

test('foreign recording responses are rejected before preview or draft insertion', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { capture: voiceCapture.start, start: speechApi.start, audio: speechApi.audio, cancel: speechApi.cancel }
  let chunk!: (samples: Int16Array, volume: number) => void
  voiceCapture.start = async callback => { chunk = callback; return { stop() {}, flush() {} } }
  speechApi.start = async () => ({ id: 'own', sample_rate: 16000, max_seconds: 120 })
  speechApi.audio = async () => ({ id: 'foreign', sequence: 0, text: '别人的文字', final: false })
  speechApi.cancel = async () => ({ cancelled: true })
  let state!: ReturnType<typeof useVoiceInput>
  function Harness() {
    state = useVoiceInput({ ownerKey: 'own', disabled: false, compact: false, value: '', cursor: 0, onInsert: () => assert.fail('foreign output') })
    return null
  }
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => state.start())
    await act(async () => chunk(new Int16Array(8000), .3))
    assert.equal(state.phase, 'error')
    assert.equal(state.error, 'speech.responseMismatch')
    assert.equal(state.text, '')
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    voiceCapture.start = original.capture; speechApi.start = original.start; speechApi.audio = original.audio; speechApi.cancel = original.cancel
  }
})


test('holding through a browser pan keeps recording; touch release finalizes preparation audio', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { capture: voiceCapture.start, start: speechApi.start, audio: speechApi.audio, cancel: speechApi.cancel }
  let chunk!: (samples: Int16Array, volume: number) => void
  let ready!: (session: Awaited<ReturnType<typeof speechApi.start>>) => void
  let stopped = 0, cancelled = 0
  const inserted: string[] = [], frames: { samples: number; final: boolean }[] = []
  voiceCapture.start = async callback => { chunk = callback; return { stop() { stopped++ }, flush() {} } }
  speechApi.start = () => new Promise(done => { ready = done })
  speechApi.cancel = async () => { cancelled++; return { cancelled: true } }
  speechApi.audio = async (id, project, sequence, audio, final) => {
    frames.push({ samples: atob(audio).length / 2, final })
    return { id, sequence, text: '滑动后仍然保留。', final }
  }
  let state!: ReturnType<typeof useVoiceInput>
  function Harness() {
    state = useVoiceInput({ ownerKey: 'held', disabled: false, compact: true, value: '', cursor: 0, onInsert: text => inserted.push(text) })
    return null
  }
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => {
      state.pointer.onPointerDown({ pointerType: 'touch', clientX: 0, clientY: 0 } as Parameters<typeof state.pointer.onPointerDown>[0])
      await new Promise(done => setTimeout(done, 530))
    })
    await act(async () => {
      chunk(new Int16Array(8000), .4)
      state.pointer.onPointerMove({ clientX: 80, clientY: 80 } as Parameters<typeof state.pointer.onPointerMove>[0])
      window.dispatchEvent(new window.PointerEvent('pointercancel', { pointerType: 'touch' }))
    })
    assert.equal(cancelled, 0)
    assert.equal(stopped, 0)
    assert.equal(state.phase, 'preparing')
    await act(async () => window.dispatchEvent(new window.Event('touchend')))
    assert.equal(state.mode, false)
    assert.equal(state.phase, 'finishing')
    assert.equal(stopped, 1)
    await act(async () => ready({ id: 'held', sample_rate: 16000, max_seconds: 120 }))
    assert.deepEqual(frames, [{ samples: 8000, final: true }])
    assert.deepEqual(inserted, ['滑动后仍然保留。'])
    assert.equal(cancelled, 0)
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    voiceCapture.start = original.capture; speechApi.start = original.start; speechApi.audio = original.audio; speechApi.cancel = original.cancel
  }
})


test('release submits final audio without waiting for the preview response round trip', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { capture: voiceCapture.start, start: speechApi.start, audio: speechApi.audio, cancel: speechApi.cancel }
  let chunk!: (samples: Int16Array, volume: number) => void
  let preview!: (result: Awaited<ReturnType<typeof speechApi.audio>>) => void
  const frames: boolean[] = [], inserted: string[] = []
  voiceCapture.start = async callback => { chunk = callback; return { stop() {}, flush() { chunk(new Int16Array(2000), .2) } } }
  speechApi.start = async () => ({ id: 'pipelined', sample_rate: 16000, max_seconds: 120 })
  speechApi.cancel = async () => ({ cancelled: true })
  speechApi.audio = async (id, project, sequence, audio, final) => {
    frames.push(final)
    if (!final) return new Promise(done => { preview = done })
    assert.equal(atob(audio).length / 2, 2000)
    return { id, sequence, text: '修正后。', final }
  }
  let state!: ReturnType<typeof useVoiceInput>
  function Harness() {
    state = useVoiceInput({ ownerKey: 'pipeline', disabled: false, compact: false, value: '', cursor: 0, onInsert: text => inserted.push(text) })
    return null
  }
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => state.start())
    await act(async () => chunk(new Int16Array(8000), .3))
    await act(async () => state.finish())
    assert.deepEqual(frames, [false, true])
    assert.deepEqual(inserted, ['修正后。'])
    await act(async () => preview({ id: 'pipelined', sequence: 0, text: '迟到的临时词', final: false }))
    assert.deepEqual(inserted, ['修正后。'])
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    voiceCapture.start = original.capture; speechApi.start = original.start; speechApi.audio = original.audio; speechApi.cancel = original.cancel
  }
})


test('six seconds of transient backlog preserves audio and catches up in one negotiated batch', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...speechApi, capture: voiceCapture.start }
  let chunk!: (pcm: Int16Array, level: number) => void
  let reply!: (value: Awaited<ReturnType<typeof speechApi.audio>>) => void
  const frames: number[] = [], inserted: string[] = []
  let cancelled = 0
  voiceCapture.start = async callback => { chunk = callback; return { stop() {}, flush() {} } }
  speechApi.start = async () => ({ id: 'backlog', sample_rate: 16000, max_seconds: 120, max_frame_samples: 128000 })
  speechApi.cancel = async () => { cancelled++; return { cancelled: true } }
  speechApi.audio = async (id, project, sequence, audio, final) => {
    frames.push(atob(audio).length / 2)
    if (sequence === 0) return new Promise(done => { reply = done })
    return { id, sequence, text: final ? '所有音频均已处理。' : '正在追赶', final }
  }
  let state!: ReturnType<typeof useVoiceInput>
  function Harness() {
    state = useVoiceInput({ ownerKey: 'backlog', disabled: false, compact: false, value: '', cursor: 0, onInsert: text => inserted.push(text) })
    return null
  }
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => state.start())
    await act(async () => { for (let i = 0; i < 13; i++) chunk(new Int16Array(8000), .4) })
    assert.equal(state.phase, 'recording')
    assert.equal(state.catchingUp, true)
    assert.equal(cancelled, 0)
    await act(async () => reply({ id: 'backlog', sequence: 0, text: '开头', final: false }))
    assert.deepEqual(frames, [8000, 96000])
    assert.equal(state.catchingUp, false)
    await act(async () => state.finish())
    assert.deepEqual(frames, [8000, 96000, 0])
    assert.deepEqual(inserted, ['所有音频均已处理。'])
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    Object.assign(speechApi, { start: original.start, audio: original.audio, cancel: original.cancel }); voiceCapture.start = original.capture
  }
})

test('system touch interruption finalizes captured speech instead of silently discarding it', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...speechApi, capture: voiceCapture.start }
  let cancelled = 0
  const inserted: string[] = []
  voiceCapture.start = async callback => ({ stop() {}, flush() { callback(new Int16Array(4000), .3) } })
  speechApi.start = async () => ({ id: 'interrupted', sample_rate: 16000, max_seconds: 120 })
  speechApi.audio = async (id, project, sequence, audio, final) => ({ id, sequence, text: '中断前的录音。', final })
  speechApi.cancel = async () => { cancelled++; return { cancelled: true } }
  let state!: ReturnType<typeof useVoiceInput>
  function Harness() {
    state = useVoiceInput({ ownerKey: 'interrupted', disabled: false, compact: true, value: '', cursor: 0, onInsert: text => inserted.push(text) })
    return null
  }
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => {
      state.pointer.onPointerDown({ pointerType: 'touch', pointerId: 42, clientX: 0, clientY: 0 } as Parameters<typeof state.pointer.onPointerDown>[0])
      await new Promise(done => setTimeout(done, 530))
    })
    await act(async () => window.dispatchEvent(new window.PointerEvent('pointerup', { pointerId: 99 })))
    assert.equal(state.phase, 'recording', 'another finger must not finish this hold')
    await act(async () => window.dispatchEvent(new window.Event('touchcancel')))
    assert.deepEqual(inserted, ['中断前的录音。'])
    assert.equal(cancelled, 0)
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    Object.assign(speechApi, { start: original.start, audio: original.audio, cancel: original.cancel }); voiceCapture.start = original.capture
  }
})


test('finish waits for the audio thread tail before sending a single final result', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...speechApi, capture: voiceCapture.start }
  let tail!: () => void, stopped = 0
  const frames: number[] = [], inserted: string[] = []
  voiceCapture.start = async callback => ({ stop() { stopped++ }, flush: () => new Promise<void>(done => {
    tail = () => { callback(new Int16Array(3000), .4); done() }
  }) })
  speechApi.start = async () => ({ id: 'tail', sample_rate: 16000, max_seconds: 120 })
  speechApi.audio = async (id, project, sequence, audio, final) => {
    assert.equal(final, true)
    frames.push(atob(audio).length / 2)
    return { id, sequence, text: '保留末尾。', final }
  }
  speechApi.cancel = async () => ({ cancelled: true })
  let state!: ReturnType<typeof useVoiceInput>
  function Harness() {
    state = useVoiceInput({ ownerKey: 'tail', disabled: false, compact: false, value: '', cursor: 0, onInsert: text => inserted.push(text) })
    return null
  }
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => state.start())
    await act(async () => { void state.finish() })
    assert.equal(stopped, 0)
    assert.deepEqual(frames, [])
    await act(async () => tail())
    assert.deepEqual(frames, [3000])
    assert.deepEqual(inserted, ['保留末尾。'])
    assert.ok(stopped > 0)
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    Object.assign(speechApi, { start: original.start, audio: original.audio, cancel: original.cancel }); voiceCapture.start = original.capture
  }
})


test('microphone loss settles already captured audio rather than deleting the recording', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...speechApi, capture: voiceCapture.start }
  const OriginalController = globalThis.AbortController
  globalThis.AbortController = window.AbortController as unknown as typeof AbortController
  let signal!: AbortSignal, chunk!: (pcm: Int16Array, level: number) => void, cancelled = 0
  const inserted: string[] = []
  voiceCapture.start = async (callback, token) => { signal = token; chunk = callback; return { stop() {}, flush() {} } }
  speechApi.start = async () => ({ id: 'lost', sample_rate: 16000, max_seconds: 120 })
  speechApi.audio = async (id, project, sequence, audio, final) => ({ id, sequence, text: '中断前的内容。', final })
  speechApi.cancel = async () => { cancelled++; return { cancelled: true } }
  let state!: ReturnType<typeof useVoiceInput>
  function Harness() {
    state = useVoiceInput({ ownerKey: 'lost', disabled: false, compact: false, value: '', cursor: 0, onInsert: text => inserted.push(text) })
    return null
  }
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => state.start())
    await act(async () => chunk(new Int16Array(8000), .4))
    await act(async () => signal.dispatchEvent(new Event('error')))
    assert.deepEqual(inserted, ['中断前的内容。'])
    assert.equal(cancelled, 0)
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    Object.assign(speechApi, { start: original.start, audio: original.audio, cancel: original.cancel }); voiceCapture.start = original.capture
    globalThis.AbortController = OriginalController
  }
})


test('mobile native long press stays available with speech enabled or disabled', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: 390 })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { status: speechApi.status, capture: voiceCapture.start, start: speechApi.start }
  let enabled = false, captures = 0, sessions = 0
  speechApi.status = async () => ({ enabled } as Awaited<ReturnType<typeof speechApi.status>>)
  voiceCapture.start = async () => { captures++; throw new Error('must not capture while disabled') }
  speechApi.start = async () => { sessions++; throw new Error('must not create session while disabled') }
  const press = async () => {
    document.querySelector('textarea')!.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }))
    await new Promise(done => setTimeout(done, 530))
  }
  try {
    await act(async () => root.render(<I18nProvider><ChatInput value="草稿" placeholder="输入消息…" onChange={() => {}} onSend={() => {}} /></I18nProvider>))
    assert.equal(document.querySelector('textarea')!.placeholder, '输入消息…')
    await act(press)
    assert.ok(document.querySelector('.voice-input') === null)
    assert.equal(captures, 0)
    assert.equal(sessions, 0)
    const contextMenu = new window.Event('contextmenu', { bubbles: true, cancelable: true })
    document.querySelector('textarea')!.dispatchEvent(contextMenu)
    assert.equal(contextMenu.defaultPrevented, false)
    enabled = true
    await act(async () => window.dispatchEvent(new window.Event('workstep:speech-settings-changed')))
    assert.equal(document.querySelector('textarea')!.placeholder, '输入消息…')
    await act(press)
    assert.equal(captures, 0)
    const nativeMenu = new window.Event('contextmenu', { bubbles: true, cancelable: true })
    document.querySelector('textarea')!.dispatchEvent(nativeMenu)
    assert.equal(nativeMenu.defaultPrevented, false)
    await act(async () => {
      document.querySelector('textarea')!.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }))
    })
    enabled = false
    await act(async () => window.dispatchEvent(new window.Event('workstep:speech-settings-changed')))
    await act(async () => new Promise(done => setTimeout(done, 530)))
    assert.equal(captures, 0)
    assert.ok(document.querySelector('.voice-input') === null)
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    speechApi.status = original.status; voiceCapture.start = original.capture; speechApi.start = original.start
  }
})


test('mobile empty composer uses click dictation and switches to send for text', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: 390 })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...speechApi, capture: voiceCapture.start }
  let enabled = true, captures = 0, sent = 0, stopped = 0
  speechApi.status = async () => ({ enabled } as Awaited<ReturnType<typeof speechApi.status>>)
  voiceCapture.start = async () => { captures++; return { stop() {}, flush() {} } }
  speechApi.start = async () => ({ id: 'mobile-click', sample_rate: 16000, max_seconds: 120 })
  speechApi.cancel = async () => ({ cancelled: true })
  const render = async (value: string, running = false, disabled = false) => {
    await act(async () => root.render(<I18nProvider><ChatInput value={value} running={running} disabled={disabled}
      onStop={() => { stopped++ }} onChange={() => {}} onSend={() => { sent++ }} /></I18nProvider>))
  }
  const action = () => document.querySelector('.chat-input-send') as HTMLButtonElement
  try {
    await render('')
    assert.equal(action().getAttribute('aria-label'), '语音输入')
    assert.equal(action().disabled, false)
    await act(async () => action().click())
    assert.equal(captures, 1)
    assert.equal(sent, 0)
    assert.equal(action().disabled, true)
    const cancel = Array.from(document.querySelectorAll('button')).find(button => button.textContent === '取消录音')!
    await act(async () => cancel.click())
    await render('草稿')
    assert.match(action().getAttribute('aria-label')!, /发送|Send/)
    await act(async () => action().click())
    assert.equal(sent, 1)
    assert.equal(captures, 1)
    const microphone = document.querySelector<HTMLButtonElement>('.voice-microphone')!
    await act(async () => microphone.click())
    assert.equal(document.querySelector('.voice-input-draft')?.textContent, '草稿')
    await act(async () => Array.from(document.querySelectorAll('button')).find(button => button.textContent === '取消录音')!.click())
    assert.ok(document.querySelector('.voice-input-draft') === null)
    assert.equal(document.querySelector('textarea')?.value, '草稿')
    await render('', true)
    await act(async () => action().click())
    assert.equal(stopped, 1)
    assert.equal(captures, 2)
    await render('', false, true)
    assert.equal(action().disabled, true)
    enabled = false
    await act(async () => window.dispatchEvent(new window.Event('workstep:speech-settings-changed')))
    await render('')
    assert.match(action().getAttribute('aria-label')!, /发送|Send/)
    assert.equal(action().disabled, true)
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    Object.assign(speechApi, { status: original.status, start: original.start, cancel: original.cancel })
    voiceCapture.start = original.capture
  }
})

test('automatic recognition keeps pre-roll and invalidates an in-flight candidate before finalizing',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const original={...speechApi},start=voiceCapture.start
 let chunk!:Parameters<typeof voiceCapture.start>[0],end=0,starts=0
 let releasePreview!:()=>void
 const turn = new TurnController()
 let checkpoint!:()=>void
 let voice!:ReturnType<typeof useVoiceInput>
 const requests:{length:number;final:boolean}[]=[]
 const sent:string[]=[]
 speechApi.start=async()=>{starts++;return {id:'gated',sample_rate:16000,max_seconds:120,max_frame_samples:128000,streaming:'segment'}}
 speechApi.audio=async(id,_p,sequence,audio,final)=>{
  requests.push({length:atob(audio).length/2,final})
  if(sequence===0)await new Promise<void>(resolve=>{releasePreview=resolve})
  return {id,sequence,final,text:sequence===0?'旧候选':'续说后的结果'}
 }
 speechApi.cancel=async()=>({cancelled:true}) as any
 voiceCapture.start=async callback=>{chunk=callback;return {stop(){},flush:()=>new Promise(resolve=>{checkpoint=()=>resolve(turn.snapshot())})}}
 function Harness(){
  voice=useVoiceInput({ownerKey:'gate',projectId:'p',disabled:false,compact:false,value:'',cursor:0,automatic:true,showLevel:false,onInsert:text=>sent.push(text)})
  return <><button onClick={()=>void voice.start()}>start</button><span>{voice.text}</span></>
 }
 const frames=(count:number,probability:number)=>{
  for(let i=0;i<count;i++)turn.frame({end:end+=512,probability})
  chunk(new Int16Array(count*512),0,turn.snapshot())
 }
 try{
  await act(async()=>root.render(<Harness/>));await act(async()=>host.querySelector('button')!.click())
  await act(async()=>{for(let i=0;i<8;i++)frames(16,.02)})
  assert.equal(starts,0,'silence never opens an ASR session')
  const recording=voice
  assert.equal(recording.hasSpeech,false)
  await act(async()=>frames(3,.6))
  assert.equal(recording.hasSpeech,true,'speech onset stays live before a transcription response')
  await act(async()=>frames(8,.02))
  assert.deepEqual(requests,[{length:6656+3*512+8*512,final:false}])
  await act(async()=>frames(11,.02))
  assert.deepEqual(sent,[],'wait for the capture watermark')
  await act(async()=>{frames(1,.6);checkpoint();releasePreview()})
  assert.equal(host.querySelector('span')!.textContent,'')
  assert.deepEqual(sent,[],'the first resumed frame vetoes the old candidate')
  await act(async()=>frames(8,.02))
  await act(async()=>frames(11,.02))
  await act(async()=>checkpoint())
  assert.deepEqual(sent,['续说后的结果'])
  assert.equal(requests[1].length,20*512)
  assert.deepEqual(requests[2],{length:11*512,final:true},'final recognition retains the tail even when VAD reports silence')
 }finally{await act(async()=>root.unmount());Object.assign(speechApi,original);voiceCapture.start=start;await window.happyDOM.close()}
})

for (const phoneCall of [false, true]) test(`SenseVoice final includes quiet tail after pause preview (${phoneCall})`, async () => {
 const {window}=installDomEnvironment(),root=createRoot(document.body.appendChild(document.createElement('div')))
 const original={...speechApi},capture=voiceCapture.start
 let chunk!:Parameters<typeof voiceCapture.start>[0],voice!:ReturnType<typeof useVoiceInput>
 let turn={lastVoice:19200,hasSpeech:true,recentSpeech:true,candidate:false,canCommit:false}
 const requests:{samples:number;final:boolean;tail:boolean}[]=[],sent:string[]=[]
 speechApi.start=async()=>({id:'quiet-tail',sample_rate:16000,max_seconds:120,max_frame_samples:128000,streaming:'segment'})
 speechApi.cancel=async()=>({cancelled:true})
 speechApi.audio=async(id,_p,sequence,audio,final)=>{
  const bytes=Uint8Array.from(atob(audio),char=>char.charCodeAt(0)),view=new DataView(bytes.buffer)
  let tail=false
  for(let i=0;i<bytes.length;i+=2)if(view.getInt16(i,true)===73)tail=true
  requests.push({samples:bytes.length/2,final,tail})
  return {id,sequence,final,text:final&&tail?'打开工作台':'打开工作'}
 }
 voiceCapture.start=async callback=>{chunk=callback;return {stop(){},flush:async()=>turn}}
 function Harness(){voice=useVoiceInput({ownerKey:'quiet-tail',disabled:false,compact:false,value:'',cursor:0,automatic:true,onInsert:text=>sent.push(text)});return <span>{voice.text}</span>}
 try{
  await act(async()=>root.render(<Harness/>));await act(async()=>voice.start(phoneCall))
  await act(async()=>chunk(new Int16Array(19200).fill(1000),.3,turn))
  await act(async()=>{turn={...turn,recentSpeech:false,candidate:true};chunk(new Int16Array(4096),0,turn)})
  assert.equal(document.querySelector('span')!.textContent,'打开工作')
  assert.deepEqual(sent,[])
  await act(async()=>{turn={...turn,canCommit:true};chunk(new Int16Array(phoneCall?16384:5632).fill(73),.01,turn)})
  assert.equal(requests.at(-1)!.final,true)
  assert.equal(requests.at(-1)!.tail,true,'VAD is a boundary signal, not permission to discard low-volume PCM')
  assert.deepEqual(sent,['打开工作台'])
 }finally{await act(async()=>root.unmount());Object.assign(speechApi,original);voiceCapture.start=capture;await window.happyDOM.close()}
})

test('the listening meter gates input by recent speech and capture time, clears on device loss', async () => {
  const {window}=installDomEnvironment()
  const originalController=globalThis.AbortController
  globalThis.AbortController=window.AbortController as unknown as typeof AbortController
  const root=createRoot(document.body.appendChild(document.createElement('div')))
  const original={ capture:voiceCapture.start, start:speechApi.start, cancel:speechApi.cancel }
  let state!:ReturnType<typeof useVoiceInput>
  let chunk!:Parameters<typeof voiceCapture.start>[0]
  let signal!:AbortSignal
  let showLevel=true
  let stopped=false
  const vad=new TurnController()
  let end=0
  const frame=(probability:number)=>vad.frame({end:end+=512,probability})
  function Harness(){
    state=useVoiceInput({ownerKey:'meter',disabled:false,compact:false,automatic:true,trackSpeechLevel:true,
      showLevel,value:'',cursor:0,onInsert:()=>{}})
    return null
  }
  voiceCapture.start=async (callback,abort)=>{
    chunk=callback; signal=abort
    return {stop(){stopped=true},flush:()=>vad.snapshot()}
  }
  speechApi.start=async()=>({id:'meter',sample_rate:16000,max_seconds:120})
  speechApi.cancel=async()=>({cancelled:true})
  const push=(level:number,capturedAt=performance.now())=>act(async()=>{
    chunk(new Int16Array(512),level,vad.snapshot(),capturedAt)
  })
  try{
    await act(async()=>root.render(<Harness/>))
    await act(async()=>state.start())
    frame(.02)
    await push(.8)
    assert.equal(state.readSpeechLevel(),0)
    for(let index=0;index<3;index++)frame(.8)
    await push(.3,performance.now()-200)
    assert.equal(state.readSpeechLevel(),0)
    await push(.3)
    assert.equal(state.readSpeechLevel(),.3)
    await push(NaN)
    assert.equal(state.readSpeechLevel(),.12)
    frame(.02)
    frame(.02)
    await push(.6)
    assert.equal(state.readSpeechLevel(),0)
    frame(.8)
    await push(.4)
    showLevel=false
    await act(async()=>root.render(<Harness/>))
    await push(.4)
    assert.equal(state.level,0,'the hidden React meter stays quiet')
    assert.equal(state.readSpeechLevel(),.4,'the microphone button can still read current speech')
    showLevel=true
    await act(async()=>root.render(<Harness/>))
    await push(.4)
    await act(async()=>signal.dispatchEvent(new Event('error')))
    assert.equal(state.readSpeechLevel(),0)
    assert.ok(stopped)
  }finally{
    globalThis.AbortController=originalController
    voiceCapture.start=original.capture
    speechApi.start=original.start
    speechApi.cancel=original.cancel
    await act(async()=>root.unmount())
    await window.happyDOM.close()
  }
})

for (const phoneCall of [false, true]) test(`SenseVoice refreshes long-speech previews without committing or losing the final tail (${phoneCall})`, async () => {
  const {window}=installDomEnvironment(), root=createRoot(document.body.appendChild(document.createElement('div')))
  const original={...speechApi}, capture=voiceCapture.start
  let voice!:ReturnType<typeof useVoiceInput>, chunk!:Parameters<typeof voiceCapture.start>[0]
  const inserted:string[]=[], requests:{final:boolean; samples:number; preview:boolean}[]=[]
  let total=0
  speechApi.start=async()=>({id:'long',sample_rate:16000,max_seconds:120,max_frame_samples:128000,streaming:'segment'})
  speechApi.cancel=async()=>({cancelled:true})
  speechApi.audio=async(id,_project,sequence,audio,final,_signal,preview=true)=>{
    total+=atob(audio).length/2;requests.push({final,samples:total,preview})
    return {id,sequence,final,text:final?'完整的最终句子。':`预览${sequence}`}
  }
  voiceCapture.start=async callback=>{chunk=callback;return {stop(){},flush(){}}}
  function Harness(){voice=useVoiceInput({ownerKey:'long',disabled:false,compact:false,continuous:true,value:'',cursor:0,onInsert:text=>inserted.push(text)});return null}
  const push=async(samples:number)=>act(async()=>chunk(new Int16Array(samples),.3,{lastVoice:total+samples,hasSpeech:true,recentSpeech:true,candidate:false,canCommit:false}))
  try {
    await act(async()=>root.render(<Harness/>));await act(async()=>voice.start(phoneCall))
    await push(19200)
    assert.equal(requests.length,1,'ordinary dictation and calls both preview the first prefix')
    assert.match(voice.text,/预览0/);assert.deepEqual(inserted,[])
    await push(16000);assert.equal(requests.length,1,'do not decode every incoming audio frame')
    await push(22400);assert.equal(requests.length,2,'refresh during a long uninterrupted sentence')
    assert.match(voice.text,/预览1/);assert.deepEqual(inserted,[])
    await push(1600);await act(async()=>voice.finish())
    assert.equal(requests.at(-1)?.final,true);assert.equal(total,59200,'finalization retains audio after the last preview')
    assert.deepEqual(inserted,['完整的最终句子。'])
  } finally {await act(async()=>root.unmount());Object.assign(speechApi,original);voiceCapture.start=capture;await window.happyDOM.close()}
})

test('resuming after a short pause preserves the visible prefix and discards a late pause candidate', async()=>{
 const {window}=installDomEnvironment(),root=createRoot(document.body.appendChild(document.createElement('div')))
 const original={...speechApi},capture=voiceCapture.start
 let voice!:ReturnType<typeof useVoiceInput>,chunk!:Parameters<typeof voiceCapture.start>[0],release!:()=>void
 let turn={lastVoice:19200,hasSpeech:true,recentSpeech:true,candidate:false,canCommit:false}
 const inserted:string[]=[]
 speechApi.start=async()=>({id:'resume',sample_rate:16000,max_seconds:120,max_frame_samples:128000,streaming:'segment'})
 speechApi.cancel=async()=>({cancelled:true})
 speechApi.audio=async(id,_p,sequence,_audio,final)=>{
  if(sequence===1)await new Promise<void>(done=>{release=done})
  return {id,sequence,final,text:final?'续说后的完整句子':'预览'+sequence}
 }
 voiceCapture.start=async callback=>{chunk=callback;return {stop(){},flush:()=>turn}}
 function Harness(){voice=useVoiceInput({ownerKey:'resume',disabled:false,compact:false,automatic:true,value:'',cursor:0,onInsert:text=>inserted.push(text)});return null}
 try{
  await act(async()=>root.render(<Harness/>));await act(async()=>voice.start())
  await act(async()=>chunk(new Int16Array(19200),.2,turn));assert.equal(voice.text,'预览0')
  await act(async()=>{turn={...turn,recentSpeech:false,candidate:true};chunk(new Int16Array(4000),0,turn)})
  await act(async()=>{turn={...turn,lastVoice:23712,recentSpeech:true,candidate:false};chunk(new Int16Array(512),.2,turn);release()})
  assert.equal(voice.text,'预览0','continue showing the useful prefix while a newer transcript is pending')
  assert.deepEqual(inserted,[])
  await act(async()=>voice.finish());assert.deepEqual(inserted,['续说后的完整句子'])
 }finally{await act(async()=>root.unmount());Object.assign(speechApi,original);voiceCapture.start=capture;await window.happyDOM.close()}
})


for (const compact of [false, true]) test(`continuous dictation joins English segments with spaces (${compact})`, async()=>{
 const {window}=installDomEnvironment(),root=createRoot(document.body.appendChild(document.createElement('div')))
 const original={...speechApi},capture=voiceCapture.start
 let voice!:ReturnType<typeof useVoiceInput>,chunk!:Parameters<typeof voiceCapture.start>[0],index=0
 const inserted:string[]=[]
 speechApi.start=async()=>({id:String(index++),sample_rate:16000,streaming:'native'})
 speechApi.cancel=async()=>({cancelled:true})
 speechApi.audio=async(id,_p,sequence,_audio,final)=>({id,sequence,final,text:['Hello, world','how are you？','fine，很好'][Number(id)]})
 voiceCapture.start=async callback=>{chunk=callback;return {stop(){},flush(){}}}
 function Harness(){voice=useVoiceInput({ownerKey:'join',disabled:false,compact,continuous:true,value:'',cursor:0,onInsert:text=>inserted.push(text)});return null}
 try{
  await act(async()=>root.render(<Harness/>));await act(async()=>voice.start())
  for(let i=0;i<3;i++)await act(async()=>chunk(new Int16Array(8000),.3,{lastVoice:i+1,hasSpeech:true,recentSpeech:false,candidate:true,canCommit:true}))
  await act(async()=>voice.finish())
  assert.deepEqual(inserted,['Hello, world how are you？ fine，很好'])
 }finally{await act(async()=>root.unmount());Object.assign(speechApi,original);voiceCapture.start=capture;await window.happyDOM.close()}
})


for(const show of [false,true])test(`voiceprint notice policy follows a portal and preserves other failures (${show})`,async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),portal=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const original={...speechApi},capture=voiceCapture.start
 let voice!:ReturnType<typeof useVoiceInput>,reason=''
 speechApi.start=async()=>{if(reason)throw new Error(reason);return {id:'notice',sample_rate:16000}}
 speechApi.cancel=async()=>({cancelled:true})
 speechApi.audio=async(id,_p,sequence,_audio,final)=>({id,sequence,final,text:'',speaker_status:'unmatched'})
 voiceCapture.start=async callback=>({stop(){},flush(){callback(new Int16Array(8000),.2)}})
 function Harness(){voice=useVoiceInput({ownerKey:'notice',disabled:false,compact:false,value:'',cursor:0,onInsert:()=>{}});return voice.notice?<p className="voice-input-notice">{voice.notice}</p>:null}
 try{
  await act(async()=>root.render(<VoiceprintNoticesContext value={show}>{createPortal(<Harness/>,portal)}</VoiceprintNoticesContext>))
  await act(async()=>voice.start());await act(async()=>voice.finish())
  assert.equal(voice.notice,show?'voiceprint.unmatched':'')
  assert.equal(portal.childElementCount,show?1:0)
  for(reason of ['speech.serviceUnavailable','speech.failed','speech.deviceLost']){
   await act(async()=>voice.cancel());await act(async()=>voice.start())
   assert.equal(voice.error,reason)
   assert.equal(voice.phase,'error')
  }
 }finally{await act(async()=>root.unmount());Object.assign(speechApi,original);voiceCapture.start=capture;await window.happyDOM.close()}
})
