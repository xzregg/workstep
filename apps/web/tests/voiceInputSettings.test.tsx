import { installDomEnvironment } from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import VoiceInputSettings from '../src/pages/VoiceInputSettings'
import { speechApi, type SpeechStatus } from '../src/api/speech'
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
