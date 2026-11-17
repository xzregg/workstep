import { installDomEnvironment } from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import VoiceInputSettings from '../src/pages/VoiceInputSettings'
import { speechApi, type SpeechStatus } from '../src/api/speech'
import { speechOutputApi } from '../src/api/speechOutput'
import { outputStatus } from './fixtures/speechOutput'
import { voiceCapture } from '../src/utils/voiceCapture'

test('settings loads the model, downloads resources, exposes cancellation and saves the enable switch', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...speechApi }
  let status: SpeechStatus = {
    enabled: false, language: 'auto', model_id: 'streaming-paraformer-zh-yue-en-int8', service: 'stopped', languages: ['auto'],
    models: [{ id: 'streaming-paraformer-zh-yue-en-int8', name: 'Streaming Paraformer 三语版 INT8', license: 'FunASR Model License', license_url: 'https://example.com/license',
      model_bytes: 238507720, installed: false, streaming: 'native',
      install: { stage: 'idle', total_bytes: null, downloaded_bytes: 0, error: '' } }],
  }
  let downloads = 0, cancelled = 0, configurations = 0
  speechApi.status = async () => structuredClone(status)
  speechApi.download = async () => { downloads++; status.models[0].install = { stage: 'downloading', total_bytes: 268082449, downloaded_bytes: 1048576, error: '' }; return structuredClone(status) }
  speechApi.cancelDownload = async () => { cancelled++; status.models[0].install.stage = 'cancelled'; return structuredClone(status) }
  speechApi.configure = async (enabled, language) => { configurations++; status = { ...status, enabled, language }; return status }
  const button = (text: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent === text)!
  try {
    await act(async () => root.render(<I18nProvider><VoiceInputSettings /></I18nProvider>))
    assert.match(document.body.textContent!, /Streaming Paraformer/)
    assert.equal((document.querySelector('input[type=checkbox]') as HTMLInputElement).checked, false)
    await act(async () => button('下载模型与运行库').click())
    assert.equal(downloads, 1)
    assert.equal(document.querySelector('progress')?.getAttribute('value'), '1048576')
    await act(async () => button('取消下载').click())
    assert.equal(cancelled, 1)
    assert.ok(button('下载模型与运行库'))
    await act(async () => (document.querySelector('input[type=checkbox]') as HTMLInputElement).click())
    assert.equal(configurations, 1)
    assert.equal(status.enabled, true)
    assert.equal(button('测试麦克风').disabled, true)
  } finally {
    Object.assign(speechApi, original)
    await act(async () => root.unmount()); await window.happyDOM.close()
  }
})


test('microphone test can retry after failure and reports completion without recognized speech', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...speechApi }
  const originalCapture = voiceCapture.start
  let captures = 0, stopped = 0
  speechApi.status = async () => ({
    enabled: true, language: 'auto', model_id: 'streaming', service: 'stopped', languages: ['auto'],
    models: [{ id: 'streaming', name: 'Streaming Paraformer', license: '来源', license_url: 'https://example.com',
      model_bytes: 1, installed: true, streaming: 'native', install: { stage: 'installed', downloaded_bytes: 1, total_bytes: 1, error: '' } }],
  })
  voiceCapture.start = async () => {
    captures++
    if (captures === 1) throw new Error('speech.audioSourceUnavailable')
    return { stop: () => { stopped++ }, flush() {} }
  }
  speechApi.start = async () => ({ id: 'a'.repeat(32), sample_rate: 16000, max_seconds: 120 })
  speechApi.audio = async (id, project, sequence, audio, final) => ({ id, sequence, text: '', final })
  speechApi.cancel = async () => ({ cancelled: true })
  const button = (text: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent === text)!
  try {
    await act(async () => root.render(<I18nProvider><VoiceInputSettings /></I18nProvider>))
    await act(async () => button('测试麦克风').click())
    assert.ok(document.querySelector('[role="alert"]'))
    await act(async () => button('测试麦克风').click())
    assert.equal(captures, 2)
    assert.match(document.body.textContent!, /正在录音/)
    await act(async () => button('完成录音').click())
    assert.ok(stopped > 0)
    assert.match(document.body.textContent!, /测试已完成/)
    assert.match(document.body.textContent!, /未识别到语音/)
    assert.equal(button('测试麦克风').disabled, false)
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    Object.assign(speechApi, original); voiceCapture.start = originalCapture
  }
})


test('installed speech model offers punctuation-only download without disabling dictation', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...speechApi }
  let downloaded = 0
  speechApi.status = async () => ({
    enabled: true, language: 'auto', model_id: 'streaming', service: 'ready', languages: ['auto'],
    models: [{ id: 'streaming', name: 'Streaming Paraformer', license: '来源', license_url: 'https://example.com',
      model_bytes: 1, installed: true, punctuation: false, streaming: 'native', install: { stage: 'installed', downloaded_bytes: 1, total_bytes: 1, error: '' } }],
  })
  speechApi.download = async () => { downloaded++; return speechApi.status() }
  try {
    await act(async () => root.render(<I18nProvider><VoiceInputSettings /></I18nProvider>))
    const buttons = Array.from(document.querySelectorAll('button'))
    assert.equal(buttons.find(button => button.textContent === '测试麦克风')!.disabled, false)
    const upgrade = buttons.find(button => button.textContent === '下载标点模型（72 MiB）')!
    assert.ok(upgrade)
    await act(async () => upgrade.click())
    assert.equal(downloaded, 1)
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close(); Object.assign(speechApi, original)
  }
})


test('two streaming models download by id and selection uses the installed current model', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...speechApi }
  const downloads: string[] = [], selections: string[] = []
  let status: SpeechStatus = {
    enabled: true, language: 'auto', model_id: 'first', service: 'stopped', languages: ['auto'],
    models: ['first', 'second'].map(id => ({ id, name: id === 'first' ? 'Paraformer' : 'Zipformer',
      license: '来源', license_url: 'https://example.com', model_bytes: 100, installed: id === 'first',
      streaming: 'native', punctuation: true, install: { stage: 'idle', downloaded_bytes: 0, total_bytes: null, error: '' } })),
  }
  speechApi.status = async () => structuredClone(status)
  speechApi.download = async id => { downloads.push(id!); status.models[1].installed = true; return structuredClone(status) }
  speechApi.configure = async (enabled, language, modelId) => { selections.push(modelId!); status.model_id = modelId!; return status }
  try {
    await act(async () => root.render(<I18nProvider><VoiceInputSettings /></I18nProvider>))
    assert.equal(document.querySelectorAll('.speech-model').length, 2)
    const second = document.querySelectorAll('.speech-model')[1]
    await act(async () => Array.from(second.querySelectorAll('button')).find(b => b.textContent === '下载模型与运行库')!.click())
    assert.deepEqual(downloads, ['second'])
    await act(async () => Array.from(second.querySelectorAll('button')).find(b => b.textContent === '使用此模型')!.click())
    assert.deepEqual(selections, ['second'])
    assert.equal(status.model_id, 'second')
    assert.equal(Array.from(document.querySelectorAll('button')).filter(b => b.textContent === '测试麦克风').length, 1)
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close(); Object.assign(speechApi, original)
  }
})

test('speech settings separates input output and wake, preserves output drafts and saves only voice fields', async () => {
  const oldOutput = { ...speechOutputApi }
  speechOutputApi.status = async () => structuredClone(outputStatus)
  speechOutputApi.save = async value => value
  const { digitalPersonApi, voiceWakeApi } = await import('../src/api/digitalPerson')
  const { window } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  const oldSpeech = speechApi.status, oldGet = digitalPersonApi.get, oldSave = digitalPersonApi.save, oldWake = voiceWakeApi.get
  let current = { enabled: true, name: '小研', role: '伙伴', personality: '严谨', duties: '', avatar: 'robot' as const, greeting: '你好', voice_rate: 1, auto_speak: false }
  digitalPersonApi.get = async () => ({...current})
  digitalPersonApi.save = async value => { current = value as typeof current; return value }
  voiceWakeApi.get = async () => ({keyword:'你好小研', sensitivity:'balanced', available:false, listening:false})
  speechApi.status = async () => ({enabled:false, language:'auto', model_id:'none', languages:['auto'], service:'stopped', models:[]})
  const switchTab = async (label: string) => act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(button => button.textContent === label)!.click())
  try {
    await act(async () => root.render(<I18nProvider><VoiceInputSettings /></I18nProvider>))
    assert.equal(host.querySelector('h1')!.textContent, '语音设置')
    assert.deepEqual([...host.querySelectorAll('[role=tab]')].map(tab => tab.textContent), ['输入','输出','唤醒'])
    await switchTab('输出')
    const output = host.querySelector<HTMLElement>('#speech-panel-output')!
    assert.equal(output.hidden, false)
    await act(async () => output.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
    await switchTab('唤醒')
    assert.equal(host.querySelector<HTMLElement>('#speech-panel-input')!.hidden, true)
    assert.ok(host.querySelector('#speech-panel-wake .voice-wake-settings'))
    assert.equal(host.querySelector('#speech-panel-wake h2') === null, true, 'tab label replaces the extra wake title')
    assert.equal(host.querySelectorAll('#speech-panel-wake .voice-wake-settings').length, 1, 'wake control is not another settings container')
    await switchTab('输出')
    assert.equal(output.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked, true)
    current.name = '已更新姓名'
    await act(async () => output.querySelector<HTMLButtonElement>('[data-save-output]')!.click())
    assert.equal(current.auto_speak, true)
    assert.equal(current.name, '已更新姓名')
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    Object.assign(speechOutputApi, oldOutput)
    speechApi.status = oldSpeech; digitalPersonApi.get = oldGet; digitalPersonApi.save = oldSave; voiceWakeApi.get = oldWake
  }
})


test('input offers cloud credentials and a self-hosted address without requiring a local model', async () => {
  const { window } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  const original = { ...speechApi }
  let saved: Parameters<typeof speechApi.configure>[3]
  let current: SpeechStatus = { enabled:true, language:'auto', model_id:'none', languages:['auto'], service:'stopped', models:[], connection:{mode:'local',provider:'tencent',base_url:'',model:'16k_zh',resource_id:'volc.seedasr.sauc.duration',app_id:''} }
  speechApi.status = async () => structuredClone(current)
  speechApi.configure = async (_enabled, _language, _model, connection) => {
    saved = connection
    current = { ...current, connection, ready:true, streaming:'final' }
    return current
  }
  let dirty=false
  const setInput = async (label:string, value:string) => {
    const input=[...host.querySelectorAll('label')].find(l=>l.firstChild?.textContent===label)!.querySelector('input')!
    await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new window.Event('input',{bubbles:true}))})
  }
  try {
    await act(async()=>root.render(<I18nProvider><VoiceInputSettings onDirtyChange={value=>{dirty=value}}/></I18nProvider>))
    const chooseMode=async (value:string)=>act(async()=>host.querySelector<HTMLInputElement>(`.speech-input-connection input[type=radio][value="${value}"]`)!.click())
    await chooseMode('cloud')
    assert.match(host.textContent!,/腾讯云/)
    assert.ok([...host.querySelectorAll('label')].some(l=>l.textContent==='SecretKey'))
    assert.equal(host.querySelectorAll('.speech-model').length,0)
    assert.equal(host.querySelector<HTMLButtonElement>('[data-save-input]')!.disabled,true)
    await chooseMode('remote')
    await setInput('服务地址','http://localhost:9001/v1')
    await setInput('模型','my-whisper')
    assert.equal(dirty,true)
    assert.match(host.textContent!,/录音结束后返回文字/)
    await act(async()=>host.querySelector<HTMLButtonElement>('[data-save-input]')!.click())
    assert.equal(saved!.base_url,'http://localhost:9001/v1')
    assert.equal(saved!.model,'my-whisper')
    assert.equal(dirty,false)
    assert.equal([...host.querySelectorAll('button')].find(b=>b.textContent==='测试麦克风')!.disabled,false)
  } finally {
    await act(async()=>root.unmount());Object.assign(speechApi,original);await window.happyDOM.close()
  }
})
