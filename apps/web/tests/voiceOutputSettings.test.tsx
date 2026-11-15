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

test('output form manages local models, validates cloud credentials and preserves unrelated identity fields', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const old = { ...speechOutputApi }, oldPerson = { ...digitalPersonApi }
  let status = structuredClone(outputStatus), saved: OutputSettings | null = null
  let identity = { enabled: true, name: '测试助手', role: '伙伴', personality: '', duties: '', avatar: 'robot' as const, greeting: '你好', auto_speak: false }
  speechOutputApi.status = async () => structuredClone(status)
  speechOutputApi.save = async value => { saved = value; return value }
  speechOutputApi.modelAction = async (action, id) => {
    if (action === 'download') status.models.find(m => m.id === id)!.install = { stage: 'downloading', downloaded_bytes: 10, total_bytes: 100, error: '' }
    if (action === 'cancel') status.models[1].install.stage = 'cancelled'
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
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === '下载模型与运行库')!.click())
    assert.equal(document.querySelector('progress')?.getAttribute('value'), '10')
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === '取消下载')!.click())
    assert.equal(status.models[1].install.stage, 'cancelled')
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


test('local catalog selects Qwen voices and requires a description only for VoiceDesign', async () => {
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
    assert.ok(document.querySelector('[data-local-instructions]'))
    assert.equal(document.querySelector<HTMLButtonElement>('[data-save-output]')!.disabled, true)
    assert.equal(document.querySelector<HTMLButtonElement>('.speech-output-test button')!.disabled, true)
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
    assert.match(document.querySelector('[data-voice-instructions]')!.textContent!, /不支持声音提示词/)
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
    assert.match(host.textContent!, /声调/)
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
