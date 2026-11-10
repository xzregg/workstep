import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useVoiceInput } from '../src/hooks/useVoiceInput'
import { speechApi } from '../src/api/speech'
import { captureVoice, voiceCapture, VoiceResampler, pcmBase64 } from '../src/utils/voiceCapture'
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
  function Harness() {
    state = useVoiceInput({ ownerKey: owner, disabled: false, compact: false, projectId: 'p',
      value: '之前之后', cursor: 2, onInsert: (text, cursor) => inserted.push([text, cursor]) })
    return null
  }
  try {
    speechApi.audio = async (id, _project, sequence, _audio, final) => ({ id, sequence, text: '粤语 English', final })
    await act(async () => root.render(<Harness />))
    await act(async () => state.start())
    assert.equal(state.phase, 'recording')
    await act(async () => chunk(new Int16Array(16000), .5))
    assert.equal(state.text, '粤语 English')
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
    voiceCapture.start = original
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

for (const width of [320, 390, 1023]) {
  test(`mobile composer has no microphone icon and enters voice mode by holding its text at ${width}px`, async () => {
    const { window } = installDomEnvironment()
    window.happyDOM.setWindowSize({ width })
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    let changes = 0
    const original = { capture: voiceCapture.start, start: speechApi.start, cancel: speechApi.cancel }
    let captures = 0
    voiceCapture.start = async () => { captures++; return { stop() {}, flush() {} } }
    speechApi.start = async () => ({ id: 'a'.repeat(32), sample_rate: 16000, max_seconds: 120 })
    speechApi.cancel = async () => ({ cancelled: true })
    const originalAudio = speechApi.audio
    speechApi.audio = () => new Promise(() => {})
    try {
      await act(async () => root.render(<I18nProvider><ChatInput value="保留这段草稿" onChange={() => { changes++ }} onSend={() => {}} /></I18nProvider>))
      assert.equal(document.querySelector('.voice-microphone'), null)
      const input = document.querySelector('textarea')!
      await act(async () => {
        input.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', clientX: 20, clientY: 20 }))
        await new Promise(done => setTimeout(done, 530))
      })
      assert.ok(document.querySelector('.voice-input'))
      assert.equal(document.querySelector('.chat-input-editor')?.getAttribute('data-voice-mode'), 'true')
      assert.equal(changes, 0)
      assert.equal(document.querySelector('textarea'), input)
      assert.equal(input.disabled, false, 'the touch target must remain enabled')
      assert.equal(input.readOnly, true, 'freeze editing without disabling the touch target')
      await act(async () => window.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' })))
      assert.equal(captures, 1)
      assert.equal(document.querySelector('.chat-input-editor')?.getAttribute('data-voice-mode'), null)
      assert.doesNotMatch(document.querySelector('.voice-input')!.textContent!, /正在录音/)
      assert.doesNotMatch(document.querySelector('.voice-input-actions')!.textContent!, /开始录音/)
    } finally {
      await act(async () => root.unmount()); await window.happyDOM.close()
      voiceCapture.start = original.capture; speechApi.start = original.start; speechApi.cancel = original.cancel; speechApi.audio = originalAudio
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
