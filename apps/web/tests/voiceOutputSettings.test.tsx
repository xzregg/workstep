import { installDomEnvironment } from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import VoiceOutputSettings from '../src/components/VoiceOutputSettings'
import { digitalPersonApi } from '../src/api/digitalPerson'
import { outputConfigured, speechOutputApi, type OutputSettings } from '../src/api/speechOutput'
import { outputStatus, qwenOutputModels } from './fixtures/speechOutput'
import { voiceCapture } from '../src/utils/voiceCapture'

test('reference recording uploads PCM WAV and preserves the sample transcript when hidden', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const old = { ...speechOutputApi }, start = voiceCapture.start
  const status = structuredClone(outputStatus)
  const model = status.models[0]
  model.runtime = 'omnivoice'
  model.voices = [{ id: 'reference', name: '参考音色' }]
  status.settings = { ...status.settings, mode: 'local', model_id: model.id, voice: 'reference', reference_id: null }
  speechOutputApi.status = async () => status
  const uploads: File[] = []
  speechOutputApi.uploadReference = async file => { uploads.push(file); return { id: 'new-reference' } }
  const signals: AbortSignal[] = []
  voiceCapture.start = async (onChunk, signal) => {
    signals.push(signal)
    return { flush: () => onChunk(new Int16Array(8000).fill(-42), 0), stop: () => {} }
  }
  const onDirtyChange = () => {}
  const initialProfile = { enabled: true, name: '测试助手', role: '', personality: '', duties: '', avatar: 'robot' as const, greeting: '' }
  const render = (active: boolean) => act(async () => root.render(<I18nProvider>
    <VoiceOutputSettings active={active} onDirtyChange={onDirtyChange} initialProfile={initialProfile} />
  </I18nProvider>))
  const click = (label: RegExp) => act(async () => [...document.querySelectorAll('button')].find(button => label.test(button.textContent ?? ''))!.click())
  try {
    await render(true)
    const sample = document.querySelector<HTMLTextAreaElement>('.speech-output-test textarea')!
    assert.doesNotMatch(sample.value, /数字人助手/)
    await click(/^(本地录制|Record locally)$/)
    await click(/^(停止并使用|Stop and use)$/)
    assert.equal(signals[0].aborted, true)
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0].type, 'audio/wav')
    const wav = Buffer.from(await uploads[0].arrayBuffer())
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
    assert.equal(wav.readUInt32LE(24), 16000)
    assert.equal(wav.readUInt32LE(40), 16000)
    assert.equal(wav.readInt16LE(44), -42)
    await click(/^(填入样例转写|Insert sample transcript)$/)
    const transcript = document.querySelector<HTMLTextAreaElement>('textarea[aria-describedby]')!
    assert.match(transcript.value, /^(晚上好|Good evening)/)
    await click(/^(本地录制|Record locally)$/)
    await render(false)
    assert.equal(signals[1].aborted, true)
    assert.equal(uploads.length, 1)
    assert.match(transcript.value, /^(晚上好|Good evening)/)
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    Object.assign(speechOutputApi, old); voiceCapture.start = start
  }
})

test('output form manages local models, validates cloud credentials and preserves unrelated identity fields', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const old = { ...speechOutputApi }, oldPerson = { ...digitalPersonApi }
  let status = structuredClone(outputStatus), saved: OutputSettings | null = null, mirror: string | undefined
  let identity = { enabled: true, name: '测试助手', role: '伙伴', personality: '', duties: '', avatar: 'robot' as const, greeting: '你好', auto_speak: false }
  speechOutputApi.status = async () => structuredClone(status)
  speechOutputApi.save = async value => { saved = value; return value }
  speechOutputApi.modelAction = async (action, id, source) => {
    if (action === 'download') mirror = source
    if (action === 'download') status.models.find(m => m.id === id)!.install = { stage: 'downloading', downloaded_bytes: 10, total_bytes: 100, error: '' }
    if (action === 'cancel') status.models[1].install = { ...status.models[1].install, stage: 'cancelled', partial_bytes: 10 }
    if (action === 'discard') {
      assert.equal(id, status.models[1].id)
      status.models[1].install = { stage: 'idle', downloaded_bytes: 0, total_bytes: null, error: '' }
    }
    return structuredClone(status)
  }
  digitalPersonApi.get = async () => ({ ...identity })
  digitalPersonApi.save = async value => { identity = value as typeof identity; return value }
  const choose = async (_label: string, value: string) => {
    const radio = document.querySelector<HTMLInputElement>(`.speech-output-settings input[type=radio][value="${value}"]`)!
    assert.ok(radio, 'output mode uses native radio options')
    await act(async () => radio.click())
    assert.equal(radio.checked, true)
  }

  try {
    await act(async () => root.render(<I18nProvider><VoiceOutputSettings onDirtyChange={() => {}} /></I18nProvider>))
    await choose('输出方式', 'local')
    assert.equal(document.querySelectorAll('.speech-output-model').length, 2)
    assert.match(document.body.textContent!, /小妮/)
    assert.match(document.body.textContent!, /(?:模型文件|Model files) .*MiB/)
    window.localStorage.setItem('workstep:voice-model-mirror:output', 'https://mirror.example/hub')
    await act(async () => root.render(<I18nProvider><VoiceOutputSettings key="mirror" onDirtyChange={() => {}} /></I18nProvider>))
    await choose('输出方式', 'local')
    assert.equal(document.querySelector<HTMLInputElement>('[data-custom-model-mirror]')?.value, 'https://mirror.example/hub')
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === '下载模型与运行库')!.click())
    assert.equal(mirror, 'https://mirror.example/hub')
    assert.equal(document.querySelector('progress')?.getAttribute('value'), '10')
    await act(async () => [...document.querySelectorAll('button')].find(b => /^(?:暂停下载|Pause download)$/.test(b.textContent ?? ''))!.click())
    assert.equal(status.models[1].install.stage, 'cancelled')
    await act(async () => [...document.querySelectorAll('button')].find(b => /^(?:继续下载|Resume download)$/.test(b.textContent ?? ''))!.click())
    assert.equal(status.models[1].install.stage, 'downloading')
    await act(async () => [...document.querySelectorAll('button')].find(b => /^(?:暂停下载|Pause download)$/.test(b.textContent ?? ''))!.click())
    await act(async () => [...document.querySelectorAll('button')].find(b => /^(?:清理下载文件|Clear downloaded files)$/.test(b.textContent ?? ''))!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click())
    assert.equal(status.models[1].install.stage, 'idle')
    identity.name = '外部更新姓名'
    await act(async () => document.querySelector<HTMLButtonElement>('[data-save-output]')!.click())
    assert.equal(saved!.mode, 'local')
    assert.equal(identity.name, '外部更新姓名')
    await choose('输出方式', 'cloud')
    assert.equal(document.querySelector<HTMLButtonElement>('[data-save-output]')!.disabled, true)
    const key = document.querySelector<HTMLInputElement>('input[type=password]')!
    await act(async () => { key.value = 'test-key'; key.dispatchEvent(new window.Event('input', { bubbles: true })) })
    // React input events are tested through validation as well as the rendered empty-key state.
    assert.ok(outputConfigured({ ...outputStatus.settings, mode: 'cloud', api_key: 'test-key' }))
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    Object.assign(speechOutputApi, old); Object.assign(digitalPersonApi, oldPerson)
  }
})

test('voicebox discovers named profiles before any profile is selected', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const old = { ...speechOutputApi }, oldGet = digitalPersonApi.get
  const status = structuredClone(outputStatus)
  status.settings = { ...status.settings, mode: 'remote', provider: 'voicebox', base_url: 'http://localhost:17493', voice: '', model: '0.6B' }
  speechOutputApi.status = async () => status
  speechOutputApi.voices = async () => [{ id: 'profile-1', name: '测试女声' }]
  digitalPersonApi.get = async () => ({ enabled: true, name: '测试助手', role: '', personality: '', duties: '', avatar: 'robot', greeting: '' })
  try {
    await act(async () => root.render(<I18nProvider><VoiceOutputSettings onDirtyChange={() => {}} /></I18nProvider>))
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === '读取音色列表')!.click())
    const option = [...document.querySelectorAll('option')].find(o => o.value === 'profile-1')!
    assert.equal(option.textContent, '测试女声')
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    Object.assign(speechOutputApi, old); digitalPersonApi.get = oldGet
  }
})

test('output restores saved cloud and remote connections without submitting revealed credentials', async () => {
  const { window } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  const old = { ...speechOutputApi }, oldPerson = { ...digitalPersonApi }, oldFetch = globalThis.fetch
  const cloud: OutputSettings = { ...outputStatus.settings, mode: 'cloud', has_api_key: true }
  const remote: OutputSettings = { ...cloud, mode: 'remote', provider: 'openai', base_url: 'https://speech.example/v1', model: 'tts-test', voice: 'alloy' }
  const profile = { enabled: true, name: '测试助手', role: '', personality: '', duties: '', avatar: 'robot' as const, greeting: '' }
  let saved: OutputSettings | undefined
  speechOutputApi.status = async () => ({ ...outputStatus, connections: [cloud, remote] })
  speechOutputApi.save = async value => { saved = value; return value }
  digitalPersonApi.get = async () => profile
  digitalPersonApi.save = async value => value
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /\/speech-output\/settings\/secret$/)
    assert.deepEqual(JSON.parse(String(options?.body)), {
      mode: 'remote', provider: 'openai', base_url: remote.base_url, region: 'beijing', app_id: '', field: 'api_key',
    })
    return Response.json({ value: 'example-remote-key' })
  }
  const choose = (mode: string) => act(async () => host.querySelector<HTMLInputElement>(`input[type=radio][value="${mode}"]`)!.click())
  const key = () => host.querySelector<HTMLInputElement>('.speech-secret-controls input')!
  const reveal = () => host.querySelector<HTMLButtonElement>('.speech-secret-controls button')!
  try {
    await act(async () => root.render(<I18nProvider><VoiceOutputSettings onDirtyChange={() => {}} /></I18nProvider>))
    await choose('cloud')
    assert.equal(reveal().disabled, false)
    await choose('local')
    await choose('remote')
    assert.equal(key().type, 'password')
    await act(async () => reveal().click())
    assert.equal(key().value, 'example-remote-key')
    assert.equal(key().type, 'text')
    await act(async () => reveal().click())
    assert.equal(key().value, '')
    await act(async () => host.querySelector<HTMLButtonElement>('[data-save-output]')!.click())
    assert.equal(saved?.base_url, remote.base_url)
    assert.equal(saved?.api_key, undefined)
  } finally {
    await act(async () => root.unmount())
    Object.assign(speechOutputApi, old); Object.assign(digitalPersonApi, oldPerson); globalThis.fetch = oldFetch
    await window.happyDOM.close()
  }
})

test('preview tests unsaved settings and stop remains clickable while session creation is pending', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const old = { ...speechOutputApi }, oldGet = digitalPersonApi.get
  const oldContext = globalThis.AudioContext
  class Context { async resume() {} async close() {} }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, writable: true, value: Context })
  const status = structuredClone(outputStatus)
  status.settings = { ...status.settings, mode: 'remote', provider: 'voicebox', base_url: 'http://localhost:17493', voice: 'profile', model: '0.6B' }
  speechOutputApi.status = async () => status
  digitalPersonApi.get = async () => ({ enabled: true, name: '测试助手', role: '', personality: '', duties: '', avatar: 'robot', greeting: '' })
  let resolve!: (value: { id: string }) => void
  let used: OutputSettings | undefined, cancelled = ''
  speechOutputApi.start = async (_text, _project, settings) => { used = settings; return new Promise(done => { resolve = done }) }
  speechOutputApi.save = async () => assert.fail('preview must not save configuration')
  speechOutputApi.cancel = async id => { cancelled = id }
  speechOutputApi.next = async () => assert.fail('stopped preview must not read audio')
  try {
    await act(async () => root.render(<I18nProvider><VoiceOutputSettings onDirtyChange={() => {}} /></I18nProvider>))
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === '连接并试听')!.click())
    const stop = [...document.querySelectorAll('button')].find(b => b.textContent === '停止播放')!
    assert.equal(stop.disabled, false)
    assert.equal(used?.voice, 'profile')
    await act(async () => stop.click())
    await act(async () => { resolve({ id: 'late-session' }); await new Promise(done => setImmediate(done)) })
    assert.equal(cancelled, 'late-session')
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    Object.assign(speechOutputApi, old); digitalPersonApi.get = oldGet
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, writable: true, value: oldContext })
  }
})


test('local catalog selects Qwen voices and prefills an editable VoiceDesign description', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const old = { ...speechOutputApi }, oldGet = digitalPersonApi.get
  const status = structuredClone(outputStatus)
  status.settings = { ...status.settings, mode: 'local', voice: '46' }
  const template = status.models[0]
  status.models.push(
    { ...template, id: 'qwen-06-custom', name: 'Qwen3-TTS 0.6B', runtime: 'qwen', instructions: false, voices: [{ id: 'Vivian', name: 'Vivian' }] },
    { ...template, id: 'qwen-17-design', name: 'Qwen3-TTS VoiceDesign', runtime: 'qwen', instructions: true, voice_design: true, voices: [{ id: 'design', name: '按描述设计音色' }] },
  )
  speechOutputApi.status = async () => status
  digitalPersonApi.get = async () => ({ enabled: true, name: '测试助手', role: '', personality: '', duties: '', avatar: 'robot', greeting: '' })
  try {
    await act(async () => root.render(<I18nProvider><VoiceOutputSettings onDirtyChange={() => {}} /></I18nProvider>))
    const selectModel = async (id: string) => {
      const card = [...document.querySelectorAll('.speech-output-model')].find(e => e.textContent?.includes(id))!
      await act(async () => [...card.querySelectorAll('button')].find(b => b.textContent === '使用此模型')!.click())
    }
    await selectModel('Qwen3-TTS 0.6B')
    assert.ok([...document.querySelectorAll('option')].some(o => o.value === 'Vivian' && o.selected))
    assert.equal(document.querySelector('[data-local-instructions]'), null)
    await selectModel('Qwen3-TTS VoiceDesign')
    assert.match(document.querySelector<HTMLTextAreaElement>('[data-local-instructions] textarea')!.value, /温柔、沉稳|gently and calmly/)
    assert.equal(document.querySelector<HTMLButtonElement>('[data-save-output]')!.disabled, false)
    assert.equal(document.querySelector<HTMLButtonElement>('.speech-output-test button')!.disabled, false)
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    Object.assign(speechOutputApi, old); digitalPersonApi.get = oldGet
  }
})


test('voice prompts support tone presets and custom text, persist to synthesis configuration and clear on unsupported models', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const old = { ...speechOutputApi }, oldPerson = { ...digitalPersonApi }
  const status = structuredClone(outputStatus)
  status.models.push(...structuredClone(qwenOutputModels))
  status.settings = { ...status.settings, mode: 'local', model_id: 'qwen-17-custom', voice: 'Serena' }
  speechOutputApi.status = async () => status
  digitalPersonApi.get = async () => ({ enabled: true, name: '测试助手', role: '', personality: '', duties: '', avatar: 'robot', greeting: '' })
  digitalPersonApi.save = async value => value
  let saved: OutputSettings | null = null
  speechOutputApi.save = async value => { saved = value; return value }
  try {
    await act(async () => root.render(<I18nProvider><VoiceOutputSettings onDirtyChange={() => {}} /></I18nProvider>))
    const prompt = document.querySelector<HTMLTextAreaElement>('[data-voice-instructions] textarea')!
    assert.ok(prompt)
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[data-voice-instructions] button')].find(b => b.textContent === '清亮高声线')!.click())
    assert.match(prompt.value, /声线偏高/)
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, prompt.value + '；带一点傲娇，吐字清晰')
      prompt.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await act(async () => document.querySelector<HTMLButtonElement>('[data-save-output]')!.click())
    assert.match(saved!.instructions, /傲娇/)
    const model = document.querySelector<HTMLSelectElement>('[data-output-model]')!
    await act(async () => { model.value = 'kokoro-v1'; model.dispatchEvent(new window.Event('change', { bubbles: true })) })
    assert.equal(document.querySelector('[data-voice-instructions] textarea'), null)
    assert.match(document.querySelector('[data-voice-instructions]')!.textContent!, /不支持声音提示词|does not support voice prompts/)
    const manager = document.querySelector<HTMLDetailsElement>('.speech-output-model-manager')!
    assert.equal(manager.open, false)
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    Object.assign(speechOutputApi, old); Object.assign(digitalPersonApi, oldPerson)
  }
})


for (const mode of ['local', 'cloud', 'remote'] as const) test(`personalization keeps ${mode} voice controls and hides service management`, async () => {
  const { window } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  const old = { ...speechOutputApi }, oldGet = digitalPersonApi.get
  const status = structuredClone(outputStatus)
  status.models.push(...structuredClone(qwenOutputModels))
  status.settings = { ...status.settings, mode, model_id: 'qwen-17-custom', voice: 'Vivian',
    model: mode === 'remote' ? '1.7B' : 'qwen3-tts-instruct-flash-realtime',
    provider: mode === 'remote' ? 'voicebox' : 'qwen', base_url: mode === 'remote' ? 'http://localhost:17493' : '', engine: 'qwen_custom_voice', has_api_key: true }
  speechOutputApi.status = async () => status
  speechOutputApi.voices = async () => [{ id: 'profile-1', name: '测试女声' }]
  digitalPersonApi.get = async () => ({ enabled: true, name: '测试助手', role: '', personality: '', duties: '', avatar: 'robot', greeting: '' })
  try {
    await act(async () => root.render(<I18nProvider><VoiceOutputSettings parametersOnly onDirtyChange={() => {}} /></I18nProvider>))
    assert.equal(host.querySelector('input[type=radio], input[type=password], [data-output-model], .speech-output-model-manager'), null)
    assert.ok(host.querySelector('[data-voice-instructions] textarea'))
    assert.match(host.querySelector('.speech-voice-presets')!.textContent!, /清亮高声线.*低沉声线/)
    if (mode === 'remote') {
      await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '读取音色列表')!.click())
      assert.equal(host.querySelector('option[value="profile-1"]')?.textContent, '测试女声')
    }
    const selects = [...host.querySelectorAll('select')]
    assert.equal(selects.length, mode === 'cloud' ? 0 : 1, 'only a voice selector is shown')
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    Object.assign(speechOutputApi, old); digitalPersonApi.get = oldGet
  }
})

test('local playback shows presets, free-form style, or tone controls for the selected model', async () => {
  const { window } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const original = { ...speechOutputApi }, oldGet = digitalPersonApi.get
  const status = structuredClone(outputStatus)
  const template = status.models[0]
  const reference = { id: 'reference', name: '参考音频' }
  status.settings = { ...status.settings, mode: 'local', model_id: 'moss-nano', voice: 'Xiaoyu' }
  status.models = [
    { ...template, id: 'moss-nano', runtime: 'moss', installed: true, voices: [{ id: 'Xiaoyu', name: 'Xiaoyu' }, reference] },
    { ...template, id: 'cosyvoice3', runtime: 'cosyvoice3', installed: true, style: 'instruction',
      instructions: true, voices: [{id: 'default', name: '默认音色'}, reference] },
    { ...template, id: 'omnivoice', runtime: 'omnivoice', installed: true, style: 'tone',
      instructions: true, voices: [{ id: 'persona', name: '跟随数字人设定' }, reference] },
  ]
  speechOutputApi.status = async () => status
  speechOutputApi.uploadReference = async file => {
    assert.equal(file.name, 'reference.wav')
    return { id: 'f'.repeat(64) }
  }
  digitalPersonApi.get = async () => ({ enabled: true, name: '测试助手', role: '', personality: '',
    duties: '', avatar: 'robot', greeting: '' })
  try {
    await act(async () => root.render(<I18nProvider><VoiceOutputSettings parametersOnly onDirtyChange={() => {}} /></I18nProvider>))
    const model = host.querySelector<HTMLSelectElement>('[data-output-model]')!
    assert.deepEqual([...model.options].map(option => option.value), ['moss-nano', 'cosyvoice3', 'omnivoice'])
    assert.ok(host.querySelector('option[value="Xiaoyu"]'))
    assert.equal(host.querySelector('[data-voice-instructions] textarea'), null)
    const select = async (name: string) => {
      await act(async () => { model.value = name; model.dispatchEvent(new window.Event('change', { bubbles: true })) })
    }
    await select('cosyvoice3')
    assert.ok(host.querySelector('[data-voice-instructions] textarea'))
    assert.equal(host.querySelectorAll('[data-voice-instructions] .speech-voice-presets button').length, 9)
    await select('omnivoice')
    assert.equal(host.querySelector('[data-voice-instructions] textarea'), null)
    assert.equal(host.querySelectorAll('[data-voice-instructions] .speech-voice-presets button').length, 4)
    const save = host.querySelector<HTMLButtonElement>('[data-save-output]')!
    assert.equal(save.disabled, false)
    const input = host.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { value: [new window.File(['sample'], 'reference.wav', { type: 'audio/wav' })] })
    await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })))
    const reference = host.querySelector<HTMLSelectElement>('.speech-output-reference-select select')!
    assert.equal(reference.value, 'f'.repeat(64))
    const [rate, volume] = host.querySelectorAll<HTMLInputElement>('.speech-output-row input')
    assert.ok(reference.compareDocumentPosition(rate) & window.Node.DOCUMENT_POSITION_FOLLOWING)
    const preview = host.querySelector<HTMLButtonElement>('.speech-output-test button[aria-busy]')!
    const enter = (input: HTMLInputElement, value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
    await enter(rate, '2.1')
    assert.equal(rate.getAttribute('aria-invalid'), 'true')
    assert.equal(preview.disabled, true)
    assert.equal(save.disabled, true)
    await enter(rate, '1')
    await enter(volume, '1.1')
    assert.equal(volume.getAttribute('aria-invalid'), 'true')
    assert.equal(preview.disabled, true)
    await enter(volume, '1')
    assert.equal(preview.disabled, false)
    assert.equal(host.querySelector('[data-voice-instructions] textarea'), null)
    assert.equal(save.disabled, false)
  } finally {
    await act(async () => root.unmount())
    host.remove()
    Object.assign(speechOutputApi, original)
    digitalPersonApi.get = oldGet
  }
})
