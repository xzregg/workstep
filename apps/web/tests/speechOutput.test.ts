import test from 'node:test'
import assert from 'node:assert/strict'
import { completedSpeechBatches, takeSpeechSentences, speechText, streamingSpeechLimit } from '../src/utils/speechOutput'
import { SpeechOutputPlayer } from '../src/utils/speechOutput'
import { speechOutputApi } from '../src/api/speechOutput'
import { ApiError } from '../src/api/transport'
import { outputStatus } from './fixtures/speechOutput'
import { voiceWakeApi } from '../src/api/digitalPerson'
import { loadSavedWakeGreeting, playWakeGreeting } from '../src/audio/wakeGreeting'

test('completed reading keeps sentences together and bounds long Unicode text without loss', () => {
  const text = '第一句话。第二句话！\n第三句还有补充。'
  assert.deepEqual(completedSpeechBatches(text), [text])
  const long = '很长的正文🙂，'.repeat(400)
  const batches = completedSpeechBatches(long)
  assert.equal(batches.join(''), long)
  assert.ok(batches.every(batch => batch.length <= 1200 && batch.isWellFormed()))
})

test('long complete reading waits for playback before creating another server session', async () => {
  const original = { ...speechOutputApi }, previous = globalThis.AudioContext
  const started: string[] = [], references: string[] = []
  let clock = 0
  class Context {
    state = 'running'; destination = {}
    get currentTime() { return clock }
    resume() { return Promise.resolve() }
    createBuffer() { return { duration: 90, sampleRate: 24000, getChannelData: () => new Float32Array(1) } }
    createBufferSource() { return { onended: null, playbackRate: { value: 1 }, connect() {}, disconnect() {}, start() {}, stop() {} } }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
  }
  globalThis.AudioContext = Context as unknown as typeof AudioContext
  const reads = new Set<string>()
  speechOutputApi.start = async text => { started.push(text); return { id: String(started.length) } }
  speechOutputApi.next = async id => {
    if (reads.has(id)) return { done: true }
    reads.add(id)
    return { done: false, audio: 'AAA=', format: 'pcm', sample_rate: 24000 }
  }
  speechOutputApi.cancel = async () => {}
  const player = new SpeechOutputPlayer({ settings: { ...outputStatus.settings, mode: 'remote' }, completeReply: true, onReference: text => references.push(text) })
  try {
    player.enqueue(['完整第一批。', '超长正文的下一批。'], { final: true })
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.deepEqual(started, ['完整第一批。'], 'no unread prefetched session expires during the long first batch')
    assert.equal(references.at(-1)?.trim(), '完整第一批。', 'unread future batches must not replace the audible echo reference')
    clock = 90
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.deepEqual(started, ['完整第一批。', '超长正文的下一批。'])
  } finally { player.stop(); globalThis.AudioContext = previous; Object.assign(speechOutputApi, original) }
})

test('native complete reading can exceed one minute without being stopped', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const previous = globalThis.window, sent: Array<{ type: string; id: string }> = []
  const bridge = { postMessage: (raw: string) => sent.push(JSON.parse(raw)), onmessage: null as null | ((event: {data: string}) => void) }
  globalThis.window = { WorkStepSpeech: bridge } as unknown as Window & typeof globalThis
  const player = new SpeechOutputPlayer({ settings: outputStatus.settings, completeReply: true })
  try {
    player.enqueue(['完整正文。'.repeat(60)], { final: true })
    context.mock.timers.tick(60001)
    assert.deepEqual(sent.map(item => item.type), ['speak'])
    bridge.onmessage?.({ data: JSON.stringify({ id: sent[0].id, status: 'done' }) })
    await Promise.resolve()
  } finally { player.stop(); globalThis.window = previous }
})

test('a host wake greeting replays twice without browser synthesis', async () => {
  const original = { ...speechOutputApi }, previous = globalThis.AudioContext
  const originalAudio = voiceWakeApi.audio
  let downloads = 0, starts = 0
  let plays = 0
  const volumes: number[] = []
  const scheduled: Float32Array[] = []
  const previousWindow = globalThis.window
  globalThis.window = { WorkStepAndroid: {} } as Window & typeof globalThis
  class Context {
    state = 'running'; currentTime = 0; destination = {}
    resume() { return Promise.resolve() }
    createBuffer(_channels: number, length: number, sampleRate: number) {
      const data = new Float32Array(length)
      return { duration: length / sampleRate, length, sampleRate, numberOfChannels: 1, getChannelData: () => data }
    }
    createGain() {
      return { gain: { set value(value: number) { volumes.push(value) } }, connect() {}, disconnect() {} }
    }
    createBufferSource() {
      return {
        onended: null as (() => void) | null, buffer: null as AudioBuffer | null,
        playbackRate: { value: 1 }, connect() {}, disconnect() {}, stop() {},
        start() { plays++; scheduled.push(this.buffer!.getChannelData(0)); setImmediate(() => this.onended?.()) },
      }
    }
  }
  globalThis.AudioContext = Context as unknown as typeof AudioContext
  speechOutputApi.status = async () => ({ ...outputStatus, settings: { ...outputStatus.settings, mode: 'remote' } })
  speechOutputApi.start = async () => { starts++; return { id: 'unexpected' } }
  voiceWakeApi.audio = async () => {
    downloads++
    return { status: 'ready', text: '我在，您说', normalized: true, volume: .4,
      chunks: [{ audio: 'ABA=', format: 'pcm', sampleRate: 24000 }] }
  }
  const { signal } = new AbortController()
  try {
    const [greeting] = await loadSavedWakeGreeting('我在，您说', 'greeting-cache-test', signal)
    assert.ok(greeting)
    const first = playWakeGreeting(greeting, 'greeting-cache-test', undefined, signal)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(plays, 0, 'Android settles the output route before playing')
    assert.equal(await first, true)
    assert.equal(await playWakeGreeting(greeting, 'greeting-cache-test', undefined, signal), true)
    assert.equal(downloads, 1)
    assert.equal(starts, 0)
    assert.equal(plays, 2)
    for (const data of scheduled) {
      assert.ok(data.length >= 4801)
      assert.ok(data.subarray(0, -1).every(value => value === 0))
      assert.equal(data.at(-1), .125)
    }
    assert.deepEqual(volumes, [.4, .4], 'server-normalized greetings use the configured volume without a second boost')
  } finally {
    globalThis.window = previousWindow
    globalThis.AudioContext = previous
    voiceWakeApi.audio = originalAudio
    Object.assign(speechOutputApi, original)
  }
})

test('an Android system wake greeting keeps playing past six seconds until native completion', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const previous = globalThis.window
  const calls: Array<{id: string; type: string; volume?: number}> = []
  const bridge: NonNullable<Window['WorkStepSpeech']> = {
    onmessage: null,
    postMessage(data) { calls.push(JSON.parse(data)) },
  }
  globalThis.window = { WorkStepAndroid: {}, WorkStepSpeech: bridge } as Window & typeof globalThis
  const controller = new AbortController()
  try {
    const played = playWakeGreeting({
      text: '我在，请慢慢说，我会听完再处理。',
      settings: { ...outputStatus.settings, mode: 'system', volume: .4 },
    }, '', undefined, controller.signal)
    context.mock.timers.tick(180)
    assert.equal(calls[0]?.type, 'speak')
    assert.equal(calls[0]?.volume, .8)
    const other = new SpeechOutputPlayer({ settings: { ...outputStatus.settings, mode: 'system' } })
    other.enqueue(['另一段播报'])
    assert.deepEqual(calls.map(call => call.type), ['speak'], 'other speech must not interrupt the wake greeting')
    context.mock.timers.tick(7000)
    assert.deepEqual(calls.map(call => call.type), ['speak'])
    bridge.onmessage?.({ data: JSON.stringify({ id: calls[0].id, status: 'done' }) })
    assert.equal(await played, true)
  } finally {
    controller.abort()
    globalThis.window = previous
  }
})

for (const format of ['pcm', 'wav'] as const) test(`Android sends the full cached ${format} greeting to the native player and waits for completion`, async () => {
  const previous = globalThis.window
  const requests: Array<{ id: string; type: string; chunks?: string[] }> = []
  const bridge: NonNullable<Window['WorkStepWakeGreeting']> = {
    onmessage: null, postMessage(data) { requests.push(JSON.parse(data)) },
  }
  globalThis.window = { WorkStepAndroid: {}, WorkStepWakeGreeting: bridge } as Window & typeof globalThis
  const controller = new AbortController()
  try {
    let completed = false
    const wrap = (audio: string) => format === 'pcm' ? audio : Buffer.concat([
      // 24 kHz mono PCM16 WAV with a two-byte JUNK chunk before the audio.
      Buffer.from('524946463000000057415645666d74201000000001000100c05d000080bb0000020010004a554e4b0200000000006461746102000000', 'hex'),
      Buffer.from(audio, 'base64'),
    ]).toString('base64')
    const played = playWakeGreeting({
      text: '完整欢迎语', settings: { ...outputStatus.settings, mode: 'remote' },
      chunks: [
        { audio: wrap('AAQ='), format, sampleRate: 24000 },
        { audio: wrap('AAg='), format, sampleRate: 24000 },
      ],
    }, '', undefined, controller.signal).then(value => { completed = true; return value })
    assert.equal(requests[0]?.type, 'wake-greeting')
    assert.deepEqual(requests[0]?.chunks, ['AAQ=', 'AAg='])
    bridge.onmessage?.({ data: JSON.stringify({ id: requests[0].id, status: 'started' }) })
    await Promise.resolve()
    assert.equal(completed, false)
    bridge.onmessage?.({ data: JSON.stringify({ id: requests[0].id, status: 'done' }) })
    assert.equal(await played, true)
  } finally {
    controller.abort()
    globalThis.window = previous
  }
})

test('an uncached wake greeting waits for all audio and discards a truncated response', async () => {
  const original = { ...speechOutputApi }, previous = globalThis.AudioContext
  let chunks = 0, contexts = 0
  globalThis.AudioContext = class { constructor() { contexts++ } } as unknown as typeof AudioContext
  speechOutputApi.start = async () => ({ id: 'greeting' })
  speechOutputApi.next = async () => ++chunks === 1
    ? { done: false, audio: 'AAA=', format: 'pcm', sample_rate: 24000 }
    : { done: true, error: 'Connection lost' }
  speechOutputApi.cancel = async () => {}
  try {
    const failure = new Promise<Error>(onError => {
      const player = new SpeechOutputPlayer({
        settings: { ...outputStatus.settings, mode: 'remote' }, wakeGreeting: true, onError,
      })
      player.enqueue(['完整欢迎语'])
    })
    assert.match((await failure).message, /Connection lost/)
    assert.equal(chunks, 2)
    assert.equal(contexts, 0, 'the first audio chunk never starts a playback graph')
  } finally {
    globalThis.AudioContext = previous
    Object.assign(speechOutputApi, original)
  }
})

test('digital playback retries a transient stream once but does not retry authentication', async () => {
  const original = { ...speechOutputApi }, started: string[] = [], cancelled: string[] = []
  speechOutputApi.start = async text => { started.push(text); return { id: String(started.length) } }
  speechOutputApi.next = async id => id === '1'
    ? { done: true, error: 'temporary', error_code: 'temporary' }
    : { done: true, error: 'authentication', error_code: 'authentication' }
  speechOutputApi.cancel = async id => { cancelled.push(id) }
  try {
    const failure = await new Promise<{ message: string; remaining: string[] }>(resolve => {
      new SpeechOutputPlayer({ settings: { ...outputStatus.settings, mode: 'remote' },
        onRecovery: (error, remaining) => resolve({ message: error.message, remaining }),
      }).enqueue(['第一句。'])
    })
    assert.deepEqual(failure, { message: 'authentication', remaining: ['第一句。'] })
    assert.deepEqual(started, ['第一句。', '第一句。'])
    assert.deepEqual(cancelled, ['1', '2'])
  } finally { Object.assign(speechOutputApi, original) }
})

test('stop during the retry delay prevents another synthesis and discards recovery', async () => {
  const original = { ...speechOutputApi }
  let starts = 0
  speechOutputApi.start = async () => { starts++; throw new ApiError('bad gateway', 502) }
  const player = new SpeechOutputPlayer({ settings: { ...outputStatus.settings, mode: 'remote' },
    onRecovery: () => assert.fail('cancelled playback must not offer recovery'),
  })
  try {
    player.enqueue(['第一句。'])
    await new Promise(resolve => setImmediate(resolve))
    player.stop()
    await new Promise(resolve => setTimeout(resolve, 450))
    assert.equal(starts, 1)
  } finally { player.stop(); Object.assign(speechOutputApi, original) }
})

test('network failures exhaust the automatic allowance after one retry', async () => {
  const original = { ...speechOutputApi }
  let starts = 0
  speechOutputApi.start = async () => { starts++; throw new TypeError('Failed to fetch') }
  try {
    const remaining = await new Promise<string[]>(resolve => {
      new SpeechOutputPlayer({ settings: { ...outputStatus.settings, mode: 'remote' },
        onRecovery: (_, pending) => resolve(pending),
      }).enqueue(['未播放。'])
    })
    assert.equal(starts, 2)
    assert.deepEqual(remaining, ['未播放。'])
  } finally { Object.assign(speechOutputApi, original) }
})

test('an audio device error leaves the unplayed segment for a manual gesture', async () => {
  const original = { ...speechOutputApi }, previous = globalThis.AudioContext
  let starts = 0
  class BlockedContext {
    state = 'suspended'
    resume() { return Promise.reject(new TypeError('Audio device unavailable')) }
  }
  globalThis.AudioContext = BlockedContext as unknown as typeof AudioContext
  speechOutputApi.start = async () => ({ id: String(++starts) })
  speechOutputApi.next = async () => ({ done: false, audio: 'AAA=', format: 'pcm', sample_rate: 24000 })
  speechOutputApi.cancel = async () => {}
  try {
    const remaining = await new Promise<string[]>(resolve => {
      new SpeechOutputPlayer({ settings: { ...outputStatus.settings, mode: 'remote' },
        onRecovery: (_, pending) => resolve(pending),
      }).enqueue(['未播放。'])
    })
    assert.equal(starts, 1)
    assert.deepEqual(remaining, ['未播放。'])
  } finally { globalThis.AudioContext = previous; Object.assign(speechOutputApi, original) }
})

test('a broken stream after audio was scheduled drains audio and retries only later text', async () => {
  const original = { ...speechOutputApi }, previous = globalThis.AudioContext
  const started: string[] = [], cancelled: string[] = []
  const source = { onended: null as (() => void) | null, playbackRate: { value: 1 }, connect() {}, disconnect() {}, start() {},
    stop() { assert.fail('scheduled audio should drain on stream failure') } }
  class Context {
    state = 'running'; currentTime = 0; destination = {}
    resume() { return Promise.resolve() }
    createBuffer() { return { duration: 1, sampleRate: 24000, getChannelData: () => new Float32Array(1) } }
    createBufferSource() { return source }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
  }
  globalThis.AudioContext = Context as unknown as typeof AudioContext
  let chunks = 0
  speechOutputApi.start = async text => { started.push(text); return { id: String(started.length) } }
  speechOutputApi.next = async () => ++chunks === 1
    ? { done: false, audio: 'AAA=', format: 'pcm', sample_rate: 24000 }
    : { done: true, error: 'temporary', error_code: 'temporary' }
  speechOutputApi.cancel = async id => { cancelled.push(id) }
  const states: boolean[] = []
  let recovered!: (remaining: string[]) => void
  const failure = new Promise<string[]>(resolve => { recovered = resolve })
  const player = new SpeechOutputPlayer({ settings: { ...outputStatus.settings, mode: 'remote' },
    onState: state => states.push(state), onRecovery: (_, remaining) => recovered(remaining),
  })
  try {
    player.enqueue(['已经开始。', '尚未开始。'])
    assert.deepEqual(await failure, ['尚未开始。'])
    assert.deepEqual(started, ['已经开始。', '尚未开始。'])
    assert.deepEqual(cancelled, ['1', '2'])
    assert.deepEqual(states, [true])
    source.onended?.()
    assert.deepEqual(states, [true, false])
  } finally { player.stop(); globalThis.AudioContext = previous; Object.assign(speechOutputApi, original) }
})

test('sentence segmentation preserves partial output, consumes each sentence once and flushes tail', () => {
  assert.deepEqual(takeSpeechSentences('你好。下一句', false), { sentences: ['你好。'], rest: '下一句' })
  assert.deepEqual(takeSpeechSentences('下一句完成！还有尾巴', true), { sentences: ['下一句完成！', '还有尾巴'], rest: '' })
  const long = '长'.repeat(300)
  const result = takeSpeechSentences(long, false)
  assert.ok(result.sentences.every(s => s.length <= 120))
  assert.equal(result.sentences.join('') + result.rest, long)
})

test('streaming sentence segmentation keeps closing marks, decimals and surrogate pairs intact', () => {
  assert.deepEqual(takeSpeechSentences('她说：“好？！”下一句', false), { sentences: ['她说：“好？！”'], rest: '下一句' })
  assert.deepEqual(takeSpeechSentences('It is 3.', false), { sentences: [], rest: 'It is 3.' })
  assert.deepEqual(takeSpeechSentences('It is 3.14. “Good.” Next', false),
    { sentences: ['It is 3.14.', '“Good.”'], rest: ' Next' })
  const long = '字'.repeat(59) + '𠮷' + '字'.repeat(60)
  const result = takeSpeechSentences(long, true, false, 60)
  assert.equal(result.sentences.join(''), long)
  assert.equal(result.sentences[0].length, 59)
  assert.ok(result.sentences.every(sentence => sentence.isWellFormed() && sentence.length <= 60))
  const { settings } = outputStatus
  assert.deepEqual([
    streamingSpeechLimit({ ...settings, mode: 'local', model_id: 'moss-nano' }),
    streamingSpeechLimit({ ...settings, mode: 'local', model_id: 'omnivoice' }),
    streamingSpeechLimit({ ...settings, mode: 'cloud', provider: 'tencent' }),
    streamingSpeechLimit({ ...settings, mode: 'remote' }),
  ], [60, 80, 120, 160])
})

test('speech removes code and URLs without reading an unfinished streaming code block', () => {
  assert.equal(speechText('你好。\n```ts\nconsole.log(1)'), '你好。\n')
  assert.equal(speechText('看[结果](https://example.com)和![图片](image.png)。'), '看结果和。')
})

test('speech skips Markdown list markers, checkboxes, thematic breaks and strikethrough delimiters', () => {
  const markdown = ['- [x] 构建通过！', '  + [ ] 等待测试。', '* 普通列表。', '1. 复查记录。', '---', '* * *', '~~旧状态~~，现为正常。', 'C++ v3.5，变化 -5%，A + B。'].join('\n')
  assert.deepEqual(takeSpeechSentences(speechText(markdown), true).sentences, [
    '构建通过！', '等待测试。', '普通列表。', '复查记录。', '旧状态，现为正常。', 'C++ v3.5，变化 -5%，A + B。',
  ])
  assert.equal(speechText('~~旧状态，接下来', false), '旧状态，接下来')
})

test('speech reads Markdown table cells in row order and skips alignment markers', () => {
  const markdown = [
    '汇总如下。', '', '| **项目** | 结果 |', '| :--- | ---: |',
    '| 构建 | [通过](https://example.com) |', '| | 待确认 |', '',
    '环境 | 状态', '--- | ---', '本地 | 正常', '', '保留正文里的 A | B。',
  ].join('\n')
  assert.deepEqual(takeSpeechSentences(speechText(markdown), true).sentences, [
    '汇总如下。', '项目，结果。', '构建，通过。', '待确认。',
    '环境，状态。', '本地，正常。', '保留正文里的 A | B。',
  ])
  assert.equal(speechText('| 表达式 |\n| --- |\n| `A\\|B` |'), '表达式。\nA|B。')
})

test('stop during session creation still collects and cancels the server session without fetching audio', async () => {
  const original = { ...speechOutputApi }
  let resolve!: (value: { id: string }) => void
  const cancelled: string[] = []
  speechOutputApi.start = () => new Promise(done => { resolve = done })
  speechOutputApi.cancel = async id => { cancelled.push(id) }
  speechOutputApi.next = async () => assert.fail('stopped playback must not fetch audio')
  try {
    const player = new SpeechOutputPlayer({ settings: { ...outputStatus.settings, mode: 'remote' } })
    player.enqueue(['你好。'])
    player.stop()
    resolve({ id: 'owned-session' })
    await new Promise(done => setImmediate(done))
    assert.deepEqual(cancelled, ['owned-session'])
  } finally { Object.assign(speechOutputApi, original) }
})


test('ordinary playback uses saved server settings; only explicit preview sends a draft', async () => {
  const original = { ...speechOutputApi }
  const drafts: unknown[] = []
  speechOutputApi.start = async (_text, _project, draft) => { drafts.push(draft); return { id: 'session' } }
  speechOutputApi.next = async () => ({ done: true })
  speechOutputApi.cancel = async () => {}
  try {
    const settings = { ...outputStatus.settings, mode: 'remote' as const }
    new SpeechOutputPlayer({ settings, projectId: 'project' }).enqueue(['正常朗读'])
    await new Promise(done => setImmediate(done))
    new SpeechOutputPlayer({ settings, preview: true }).enqueue(['设置试听'])
    await new Promise(done => setImmediate(done))
    assert.deepEqual(drafts, [undefined, settings])
  } finally { Object.assign(speechOutputApi, original) }
})


for (const platform of ['WorkStepAndroid', 'WorkStepIOS']) test(`${platform} system playback uses native acknowledgements and cancels the owned utterance`, async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const sent: {type: string; id: string; text?: string}[] = []
  const bridge = { postMessage(message: string) { sent.push(JSON.parse(message)) }, onmessage: null as null | ((event: {data: string}) => void) }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { WorkStepSpeech: bridge, [platform]: {} } })
  try {
    const states: boolean[] = []
    const player = new SpeechOutputPlayer({ settings: outputStatus.settings, onState: state => states.push(state) })
    player.enqueue(['第一句。', '第二句。'])
    assert.equal(sent[0].text, '第一句。')
    bridge.onmessage!({ data: JSON.stringify({ id: sent[0].id, status: 'done' }) })
    await new Promise(done => setImmediate(done))
    assert.equal(sent[1].text, '第二句。')
    player.stop()
    assert.deepEqual(sent[2], { type: 'stop', id: sent[1].id })
    assert.equal(states.at(-1), false)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('coalesced playback starts the opening separately when a full reply is already available', async () => {
  const original = { ...speechOutputApi }, started: string[] = []
  let release!: (value: { done: boolean }) => void
  speechOutputApi.start = async text => { started.push(text); return { id: `s${started.length}` } }
  speechOutputApi.next = async id => id === 's1' ? new Promise(resolve => { release = resolve }) : { done: true }
  speechOutputApi.cancel = async () => {}
  const player = new SpeechOutputPlayer({ settings: { ...outputStatus.settings, mode: 'remote' }, coalesce: true })
  try {
    player.enqueue(['第一句。', '第二句。', '第三句。'])
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(started, ['第一句。', '第二句。第三句。'])
  } finally {
    player.stop(); release?.({ done: true }); await new Promise(resolve => setImmediate(resolve))
    Object.assign(speechOutputApi, original)
  }
})

test('streaming playback batches separate updates before prefetch and flushes the final tail', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const original = { ...speechOutputApi }, started: string[] = [], cancelled: string[] = []
  let finishOpening!: (value: { done: boolean }) => void
  speechOutputApi.start = async text => { started.push(text); return { id: String(started.length) } }
  speechOutputApi.next = async id => id === '1' ? new Promise(resolve => { finishOpening = resolve }) : { done: true }
  speechOutputApi.cancel = async id => { cancelled.push(id) }
  const player = new SpeechOutputPlayer({ settings: { ...outputStatus.settings, mode: 'remote' }, batchStreaming: true })
  try {
    player.enqueue(['Opening.'])
    await new Promise(resolve => setImmediate(resolve))
    player.enqueue(['Second!'])
    context.mock.timers.tick(200)
    player.enqueue(['“Third?”'])
    assert.deepEqual(started, ['Opening.'])
    context.mock.timers.tick(150)
    assert.deepEqual(started, ['Opening.', 'Second! “Third?”'])
    player.enqueue(['Fourth.', 'Tail'], { final: true })
    assert.equal(started.length, 2, 'only one future request can be in flight')
    finishOpening({ done: true })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(started, ['Opening.', 'Second! “Third?”', 'Fourth. Tail'])
    assert.deepEqual(cancelled, ['1', '2', '3'])
  } finally {
    player.stop(); finishOpening?.({ done: true })
    await new Promise(resolve => setImmediate(resolve))
    Object.assign(speechOutputApi, original)
  }
})

test('streaming prefetch honors the local model budget and stop discards waiting text', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const original = { ...speechOutputApi }, started: string[] = []
  let finishOpening!: (value: { done: boolean }) => void
  speechOutputApi.start = async text => { started.push(text); return { id: String(started.length) } }
  speechOutputApi.next = async () => new Promise(resolve => { finishOpening = resolve })
  speechOutputApi.cancel = async () => {}
  const player = new SpeechOutputPlayer({ settings: { ...outputStatus.settings, mode: 'local', model_id: 'omnivoice' }, batchStreaming: true })
  try {
    const full = '字'.repeat(79) + '。'
    player.enqueue(['首句。'])
    await new Promise(resolve => setImmediate(resolve))
    player.enqueue(['较短的一句。'])
    assert.deepEqual(started, ['首句。'])
    player.enqueue([full, '待取消。'])
    assert.deepEqual(started, ['首句。', '较短的一句。'])
    player.stop()
    context.mock.timers.tick(1000)
    finishOpening({ done: true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(started.length, 2)
  } finally {
    player.stop(); finishOpening?.({ done: true })
    await new Promise(resolve => setImmediate(resolve))
    Object.assign(speechOutputApi, original)
  }
})

test('a partial merged stream retries as a unit and keeps the already submitted successor separate', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const original = { ...speechOutputApi }, started: string[] = []
  let finishOpening!: (value: { done: boolean }) => void
  let received = 0, failBatch!: (value: { done: true; error: string; error_code: 'temporary' }) => void
  speechOutputApi.start = async text => { started.push(text); return { id: String(started.length) } }
  speechOutputApi.next = async id => {
    if (id === '1') return new Promise(resolve => { finishOpening = resolve })
    if (id !== '2' && id !== '4') return { done: true }
    if (++received % 2) return { done: false, audio: 'AAA=', format: 'pcm', sample_rate: 24000 }
    if (id === '2') return new Promise(resolve => { failBatch = resolve })
    return { done: true, error: '断流', error_code: 'temporary' }
  }
  speechOutputApi.cancel = async () => {}
  const settings = { ...outputStatus.settings, mode: 'remote' as const, provider: 'tencent' }
  let recovery: { pending: string[]; submitted: number } | undefined
  const player = new SpeechOutputPlayer({ settings, batchStreaming: true,
    onRecovery: (_, pending, submitted) => { recovery = { pending, submitted } },
  })
  const resumed = new SpeechOutputPlayer({ settings, batchStreaming: true })
  try {
    const second = '乙'.repeat(59) + '。'
    const third = '丙'.repeat(59) + '。'
    player.enqueue(['首句。', second, third, '第四句。'])
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(started, ['首句。', second + third])
    finishOpening({ done: true })
    await new Promise(resolve => setImmediate(resolve))
    context.mock.timers.tick(350)
    assert.deepEqual(started, ['首句。', second + third, '第四句。'])
    player.enqueue(['尾巴。'], { final: true })
    failBatch({ done: true, error: '断流', error_code: 'temporary' })
    await new Promise(resolve => setImmediate(resolve))
    context.mock.timers.tick(350)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(started, ['首句。', second + third, '第四句。', second + third])
    assert.deepEqual(recovery, { pending: [second + third, '第四句。', '尾巴。'], submitted: 2 })
    resumed.enqueue([...recovery!.pending, '恢复。'], { final: true, submitted: recovery!.submitted })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(started.slice(4), [second + third, '第四句。', '尾巴。恢复。'])
  } finally {
    player.stop(); resumed.stop()
    finishOpening?.({ done: true })
    failBatch?.({ done: true, error: '断流', error_code: 'temporary' })
    await new Promise(resolve => setImmediate(resolve))
    Object.assign(speechOutputApi, original)
  }
})

test('queued short phrases coalesce and prepare one following synthesis before current audio completes',async()=>{
 const original={...speechOutputApi},started:string[]=[],cancelled:string[]=[]
 let release!:(value:any)=>void
 speechOutputApi.start=async text=>{started.push(text);return {id:`s${started.length}`}}
 speechOutputApi.next=async id=>id==='s1'?new Promise(resolve=>{release=resolve}):{done:true}
 speechOutputApi.cancel=async id=>{cancelled.push(id)}
 const player=new SpeechOutputPlayer({settings:{...outputStatus.settings,mode:'remote'},coalesce:true})
 try{
  player.enqueue(['第一句。']);await new Promise(resolve=>setImmediate(resolve))
  player.enqueue(['第二句。','第三句。']);await new Promise(resolve=>setImmediate(resolve))
  assert.deepEqual(started,['第一句。','第二句。第三句。'],'one bounded lookahead synthesis, not one cold request per tiny sentence')
  release({done:true});await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve))
  assert.deepEqual(cancelled.sort(),['s1','s2'])
 }finally{player.stop();Object.assign(speechOutputApi,original)}
})

test('stop collects and cancels a late prefetched synthesis too',async()=>{
 const original={...speechOutputApi},cancelled:string[]=[]
 let ahead!:(value:{id:string})=>void,finish!:(value:any)=>void,count=0
 speechOutputApi.start=async()=>++count===1?{id:'current'}:new Promise(resolve=>{ahead=resolve})
 speechOutputApi.next=async()=>new Promise(resolve=>{finish=resolve})
 speechOutputApi.cancel=async id=>{cancelled.push(id)}
 const player=new SpeechOutputPlayer({settings:{...outputStatus.settings,mode:'remote'},coalesce:true})
 try{
  player.enqueue(['第一句']);await new Promise(resolve=>setImmediate(resolve))
  player.enqueue(['后一句']);await new Promise(resolve=>setImmediate(resolve))
  assert.equal(count,2)
  player.stop();ahead({id:'ahead'});finish({done:true})
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve))
  assert.deepEqual(cancelled.sort(),['ahead','current'])
 }finally{player.stop();Object.assign(speechOutputApi,original)}
})

test('voice gesture unlocks one output context reused after a turn stops',async()=>{
 const {primeSpeechOutput}=await import('../src/utils/speechOutput')
 const previous=globalThis.AudioContext;let created=0,closed=0,resumed=0
 class Context{state='running';constructor(){created++}resume(){resumed++;return Promise.resolve()}close(){closed++;return Promise.resolve()}}
 globalThis.AudioContext=Context as any
 try{
  primeSpeechOutput()
  const first=new SpeechOutputPlayer({settings:{...outputStatus.settings,mode:'remote'}})
  await first.unlock();first.stop()
  const next=new SpeechOutputPlayer({settings:{...outputStatus.settings,mode:'remote'}})
  await next.unlock();next.stop()
  assert.equal(created,1);assert.equal(closed,0);assert.ok(resumed>=3)
 }finally{globalThis.AudioContext=previous}
})
