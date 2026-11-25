import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { assistantApi, providerApi } from '../src/api/client'
import AssistantEngineSettings from '../src/components/AssistantEngineSettings'

test('general assistant settings excludes digital person while its dedicated settings remain writable', async () => {
  const { window } = installDomEnvironment(), host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  const list = assistantApi.list, providers = providerApi.list, setConfig = assistantApi.setConfig
  const calls: string[] = []
  assistantApi.list = async () => ({ assistants: ['digital_person','chat_session'].map(name => ({name, fields:['engine'], configured:{}, resolved:{}, available_engines:[]})) }) as any
  providerApi.list = async () => ({providers:[]})
  assistantApi.setConfig = async name => { calls.push(name); return {configured:{},resolved:{}} as any }
  try {
    await act(async () => root.render(<I18nProvider><AssistantEngineSettings /></I18nProvider>))
    const general = host.querySelector('.assistant-engine-tabs')!
    assert.equal(general.querySelectorAll('button').length, 1)
    assert.equal(general.textContent!.includes('数字人'), false)
    await act(async () => host.querySelector<HTMLButtonElement>('.assistant-engine-footer button')!.click())
    assert.deepEqual(calls, ['chat_session'])
    await act(async () => root.render(<I18nProvider><AssistantEngineSettings key="digital" assistantName="digital_person" /></I18nProvider>))
    assert.ok(host.querySelector('.assistant-engine-tabs') === null)
    await act(async () => host.querySelector<HTMLButtonElement>('.assistant-engine-footer button')!.click())
    assert.deepEqual(calls, ['chat_session','digital_person'])
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    assistantApi.list = list; providerApi.list = providers; assistantApi.setConfig = setConfig
  }
})

test('vision settings uses inherited engine/provider, configures multimodal models inline and preserves hidden configuration', async () => {
  const { window } = installDomEnvironment(), host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  const { systemSettingsApi, engineApi } = await import('../src/api/client')
  const original = { list: assistantApi.list, providers: providerApi.list, save: assistantApi.setConfig, settings: systemSettingsApi.modelSettings, saveSettings: systemSettingsApi.saveModelSettings, models: engineApi.models }
  let payload: any, savedModel: any
  const sources: string[] = []
  const configured = { engine: '', provider_id: '', model: 'text', fast_model: 'fast', vision_model: '', thinking_effort: 'high' }
  assistantApi.list = async () => ({ assistants: [{ name: 'digital_person', fields: ['engine', 'provider_id', 'model', 'fast_model', 'vision_model', 'thinking_effort'], configured,
    resolved: { ...configured, engine: 'vision-test-engine', provider_id: 'camera-provider' }, available_engines: [{ id: 'vision-test-engine', installed: true, built_in: true, supports_provider: true, provider_protocols: ['openai'] }] }] }) as any
  providerApi.list = async () => ({ providers: [{ id: 'camera-provider', name: '测试供应商', enabled: true, protocol: 'openai' }] }) as any
  systemSettingsApi.modelSettings = async () => ({ prices: [{ model: 'vl', provider_id: 'camera-provider', supports_multimodal: true }, { model: 'text', provider_id: 'camera-provider', supports_multimodal: false }] }) as any
  engineApi.models = async (engine, provider) => { sources.push(`${engine}/${provider}`); return { models: [{ id: 'text', label: '文本' }, { id: 'vl', label: '视觉模型' }], error: null } as any }
  systemSettingsApi.saveModelSettings = async value => { savedModel = value; return value as any }
  assistantApi.setConfig = async (_name, value) => { payload = value; return { configured: {}, resolved: {} } as any }
  try {
    await act(async () => root.render(<I18nProvider><AssistantEngineSettings assistantName="digital_person" section="vision" /></I18nProvider>))
    assert.deepEqual(sources, ['vision-test-engine/camera-provider'])
    assert.equal(host.querySelectorAll('select').length, 3)
    assert.equal(host.querySelector<HTMLButtonElement>('.assistant-engine-footer button')!.disabled, false, 'inherited vision model can be saved without a forced override')
    await act(async () => host.querySelector<HTMLButtonElement>('.assistant-engine-footer button')!.click())
    assert.equal(payload.engine, '')
    assert.equal(payload.visionModel, '')
    assert.equal(payload.model, 'text')
    const vision = host.querySelector<HTMLSelectElement>('[aria-label="默认多模态模型"]') || host.querySelectorAll<HTMLSelectElement>('select')[2]
    assert.deepEqual([...vision.options].map(option => option.value), ['', 'text', 'vl'])
    await act(async () => { vision.value = 'vl'; vision.dispatchEvent(new window.Event('change', { bubbles: true })) })
    await act(async () => host.querySelector<HTMLButtonElement>('.assistant-engine-footer button')!.click())
    assert.equal(payload.visionModel, 'vl'); assert.equal(payload.model, 'text'); assert.equal(payload.fastModel, 'fast'); assert.equal(payload.thinkingEffort, 'high')
    assert.equal(payload.providerId, '')
    await act(async () => { vision.value = 'text'; vision.dispatchEvent(new window.Event('change', { bubbles: true })) })
    const capability = host.querySelector<HTMLInputElement>('.assistant-engine-vision-capability input')!
    assert.equal(capability.checked, false)
    assert.equal(host.querySelector<HTMLButtonElement>('.assistant-engine-footer button')!.disabled, true)
    await act(async () => capability.click())
    await act(async () => host.querySelector<HTMLButtonElement>('.assistant-engine-footer button')!.click())
    assert.equal(savedModel.prices.find((item: any) => item.model === 'text').supports_multimodal, true)
    assert.equal(savedModel.prices.length, 2)
    assert.equal(payload.visionModel, 'text')
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    assistantApi.list = original.list; providerApi.list = original.providers; assistantApi.setConfig = original.save; systemSettingsApi.modelSettings = original.settings; systemSettingsApi.saveModelSettings = original.saveSettings; engineApi.models = original.models
  }
})
