import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { engineApi, invalidateEngineModels, type EngineInfo, type EngineModelsResult } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import EngineSettingsPanel from '../src/components/EngineSettingsPanel'
import EngineSelect from '../src/components/EngineSelect'
import { resetEngineAvailabilityStoreForTests, useCoordinatorEngines } from '../src/stores/engineAvailabilityStore'

test('provider drafts replace model options and ignore late responses', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originals = { list: engineApi.list, executionConfig: engineApi.executionConfig, models: engineApi.models }
  const calls: unknown[] = []
  let finishSlow!: (result: EngineModelsResult) => void
  const result = (provider: string): EngineModelsResult => ({
    engine_id: 'codex', models: [
      { id: `${provider}-model`, label: `${provider} model`, description: null },
      { id: `${provider}-unnamed`, label: null as unknown as string, description: null },
      { id: `${provider}-blank`, label: '   ', description: null },
    ],
    default_model: '', error: null,
  })
  const item = {
    id: 'codex', installed: true, supports_provider: true, provider_protocols: ['openai'],
    config: {
      fields: [{ key: 'provider_id', label: '供应商', type: 'select', required: false,
        placeholder: '', help: '', default: '', sensitive: false, confirm_values: [],
        options: ['saved', 'slow', 'new'].map((value) => ({ value, label: value })) }],
      step_fields: [], values: { provider_id: 'saved' }, secrets: {},
    },
  } as EngineInfo
  engineApi.list = async () => ({ engines: [item] })
  engineApi.executionConfig = async () => ({ engine: '' })
  engineApi.models = async (_engine, provider = '', refresh = false) => {
    calls.push([provider, refresh])
    if (provider === 'slow') return new Promise((resolve) => { finishSlow = resolve })
    return result(provider || 'native')
  }
  invalidateEngineModels('codex')
  const options = () => Array.from(container.querySelector<HTMLSelectElement>('#default-model-codex')!.options).map((option) => option.value)
  const choose = async (provider: string) => {
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>('#engine-config-codex-provider_id')!
      select.value = provider
      select.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
  }
  try {
    await act(async () => root.render(<I18nProvider><EngineSettingsPanel hidden={false} refreshRevision={0} preferredProviderProtocol="" /></I18nProvider>))
    assert.deepEqual(calls, [], 'mounting must preserve the saved provider without fetching')
    await act(async () => { container.querySelector<HTMLButtonElement>('.engine-settings-expand-button')!.click() })
    assert.deepEqual(calls, [['saved', false]])
    assert.ok(options().includes('saved-model'))
    assert.equal(container.querySelector('option[value="saved-unnamed"]')?.textContent, 'saved-unnamed')
    assert.equal(container.querySelector('option[value="saved-blank"]')?.textContent, 'saved-blank')
    await choose('slow')
    assert.equal(container.querySelector<HTMLSelectElement>('#default-model-codex')!.disabled, true)
    assert.ok(!options().includes('saved-model'))
    await choose('new')
    assert.ok(options().includes('new-model'))
    await act(async () => { finishSlow(result('slow')) })
    assert.ok(options().includes('new-model'))
    assert.ok(!options().includes('slow-model'))
    await choose('')
    assert.ok(options().includes('native-model'))
    await choose('saved')
    assert.ok(options().includes('saved-model'))
    assert.deepEqual(calls, [['saved', false], ['slow', false], ['new', false], ['', false]])
  } finally {
    Object.assign(engineApi, originals)
    invalidateEngineModels('codex')
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('engine catalog loads once while hidden and refreshes after provider changes', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalList = engineApi.list
  const originalExecutionConfig = engineApi.executionConfig
  let loads = 0
  engineApi.list = async () => { loads += 1; return { engines: [] } }
  engineApi.executionConfig = async () => ({ engine: '' })
  const render = async (hidden: boolean, refreshRevision: number) => {
    await act(async () => root.render(<I18nProvider><EngineSettingsPanel
      hidden={hidden} refreshRevision={refreshRevision} preferredProviderProtocol=""
    /></I18nProvider>))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
  try {
    await render(true, 0)
    assert.equal(loads, 1)
    await render(false, 0)
    assert.equal(loads, 1)
    await render(false, 1)
    assert.equal(loads, 2)
  } finally {
    engineApi.list = originalList
    engineApi.executionConfig = originalExecutionConfig
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})


test('visibility switch saves and refreshes the full settings catalog', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const originalList = engineApi.list
  const originalConfig = engineApi.executionConfig
  const originalVisibility = engineApi.setVisibility
  const item = { id: 'codex', enabled: false, installed: false, configured: false, verified: false, built_in: false, config: null, installable: false, updatable: false } as import('../src/api/client').EngineInfo
  const calls: unknown[] = []
  engineApi.list = async () => ({ engines: [item] })
  engineApi.executionConfig = async () => ({ engine: '' })
  engineApi.setVisibility = async (id, enabled) => {
    calls.push([id, enabled])
    return { engines: [{ ...item, enabled }] }
  }
  try {
    await act(async () => root.render(<I18nProvider><EngineSettingsPanel hidden={false} refreshRevision={0} preferredProviderProtocol="" /></I18nProvider>))
    const toggle = document.querySelector('.engine-settings-visibility [role="switch"]') as HTMLButtonElement
    assert.equal(toggle.getAttribute('aria-checked'), 'false')
    assert.equal(document.querySelector('.engine-settings-visibility > span')?.textContent, '关闭')
    await act(async () => { toggle.click() })
    assert.deepEqual(calls, [['codex', true]])
    assert.equal(document.querySelector('.engine-settings-visibility [role="switch"]')?.getAttribute('aria-checked'), 'true')
    assert.equal(document.querySelector('.engine-settings-visibility > span')?.textContent, '开启')
  } finally {
    engineApi.list = originalList
    engineApi.executionConfig = originalConfig
    engineApi.setVisibility = originalVisibility
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


function LiveEngineSelector() {
  const engines = useCoordinatorEngines()
  return <EngineSelect engines={engines} value="" onChange={() => {}} requireCoordinator />
}

test('rescan publishes a newly registered custom engine to an already open selector', async () => {
  const { window, document } = installDomEnvironment()
  resetEngineAvailabilityStoreForTests()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const originals = { list: engineApi.list, refresh: engineApi.refresh, executionConfig: engineApi.executionConfig }
  const custom = { id: 'example_custom', name: 'Example custom', custom: true,
    installed: true, configured: true, verified: true, enabled: true,
    supports_coordinator: true, mode: 'sdk', config: null } as EngineInfo
  engineApi.list = async () => ({ engines: [] })
  engineApi.refresh = async () => ({ engines: [custom] })
  engineApi.executionConfig = async () => ({ engine: '' })
  try {
    await act(async () => root.render(<I18nProvider>
      <LiveEngineSelector />
      <EngineSettingsPanel hidden={false} refreshRevision={0} preferredProviderProtocol="" />
    </I18nProvider>))
    assert.equal(document.querySelector('option[value="example_custom"]'), null)
    await act(async () => {
      (document.querySelector('.engine-settings-header > button') as HTMLButtonElement).click()
    })
    const option = document.querySelector('option[value="example_custom"]')
    assert.ok(option, '已打开的选择框应立即显示新自定义引擎')
    assert.equal(option.hasAttribute('disabled'), false)
  } finally {
    engineApi.list = originals.list
    engineApi.refresh = originals.refresh
    engineApi.executionConfig = originals.executionConfig
    await act(async () => root.unmount())
    resetEngineAvailabilityStoreForTests()
    await window.happyDOM.close()
  }
})
