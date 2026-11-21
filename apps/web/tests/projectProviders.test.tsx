import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { engineApi, providerApi, type ProviderInfo, type CoordinatorEngineSummary } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import ProviderSettings from '../src/pages/ProviderSettings'
import CoordinatorConfigBar from '../src/components/CoordinatorConfigBar'
import { notifyProvidersChanged, useProjectProviders } from '../src/hooks/useProjectProviders'

test('distributed providers expose saved models without local mutation controls', async () => {
  const { window, document } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { list: providerApi.list, models: providerApi.models }
  providerApi.list = async () => ({ providers: [{ id: 'managed', name: 'Managed', enabled: true,
    managed: true, protocols: ['openai_responses'], protocol: 'openai_responses', model_count: 1 } as ProviderInfo], types: [] })
  providerApi.models = async () => ({ provider_id: 'managed', models: [{ id: 'allowed', label: 'allowed', description: null }], error: null })
  try {
    await act(async () => root.render(<I18nProvider><ProviderSettings /></I18nProvider>))
    const card = document.querySelector('[data-provider-id="managed"]')!
    assert.match(card.textContent!, /由网关管理/)
    assert.equal(card.querySelector('[role="switch"]'), null)
    assert.equal(card.querySelector('.provider-settings-action--delete'), null)
    assert.ok(![...card.querySelectorAll('button')].some(button => ['获取模型', '编辑', '复制配置'].includes(button.textContent!.trim())))
    const saved = card.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!
    await act(async () => saved.click())
    assert.ok(document.querySelector('[role="dialog"]')!.textContent!.includes('allowed'))
  } finally {
    await act(async () => root.unmount())
    Object.assign(providerApi, original)
    await window.happyDOM.close()
  }
})

test('provider settings changes update the mounted composer without switching projects', async () => {
  const { window, document } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { list: providerApi.list, save: providerApi.save, models: providerApi.models }
  let provider = { id: 'openai', name: 'OpenAI', type: 'openai', enabled: false,
    protocols: ['openai_responses'], protocol: 'openai_responses', model_count: 0 } as ProviderInfo
  const scopes: string[] = []
  providerApi.list = async (projectId = '') => {
    scopes.push(projectId)
    return { providers: [{ ...provider }], types: [] }
  }
  providerApi.models = async () => ({ provider_id: provider.id, models: [], error: null })
  providerApi.save = async input => {
    provider = { ...provider, enabled: input.enabled! }
    return { saved: true, provider }
  }
  function Composer() {
    const providers = useProjectProviders('project-a')
    return <CoordinatorConfigBar engines={[{ id: 'codex', supports_provider: true,
      provider_protocols: ['openai_responses'] } as CoordinatorEngineSummary]}
      providers={providers} engine="codex" defaultEngine="" model="" fastModel=""
      onEngineChange={() => {}} onProviderChange={() => {}}
      onModelChange={() => {}} onFastModelChange={() => {}} />
  }
  try {
    await act(async () => root.render(<I18nProvider><Composer /><ProviderSettings /></I18nProvider>))
    assert.equal(document.querySelector('option[value="openai"]'), null)
    for (const expected of [true, false]) {
      const toggle = document.querySelector<HTMLButtonElement>('.provider-settings-page [role="switch"]')!
      assert.ok(toggle)
      assert.equal(toggle.getAttribute('aria-checked'), String(!expected))
      await act(async () => toggle.click())
      assert.equal(toggle.getAttribute('aria-checked'), String(expected))
      assert.equal(document.querySelector('option[value="openai"]') !== null, expected)
    }
    assert.equal(scopes.filter(scope => scope === 'project-a').length, 3)
  } finally {
    await act(async () => root.unmount())
    Object.assign(providerApi, original)
    await window.happyDOM.close()
  }
})

test('a failed connection test does not prevent choosing a compatible managed provider', async () => {
  const { window, document } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { list: providerApi.list, models: engineApi.models }
  providerApi.list = async () => ({ providers: [{ id: 'managed-failed', name: 'Managed Failed', enabled: true,
    managed: true, verified: false, test_success: false,
    protocols: ['openai_responses'], protocol: 'openai_responses' } as ProviderInfo], types: [] })
  engineApi.models = async (engineId, providerId) => ({ engine_id: engineId, default_model: '', error: null,
    models: providerId === 'managed-failed' ? [{ id: 'allowed', label: 'Allowed model', description: null }] : [] })
  let selectedModel = ''
  function Composer() {
    const providers = useProjectProviders('project-managed')
    const [providerId, setProviderId] = useState('')
    return <CoordinatorConfigBar engines={[{ id: 'codex', supports_provider: true,
      provider_protocols: ['openai_responses'] } as CoordinatorEngineSummary]}
      variant="menu" projectId="project-managed" providerId={providerId}
      providers={providers} engine="codex" defaultEngine="" model="" fastModel=""
      onEngineChange={() => {}} onProviderChange={setProviderId}
      onModelChange={(id) => { selectedModel = id }} onFastModelChange={() => {}} />
  }
  try {
    await act(async () => root.render(<I18nProvider><Composer /></I18nProvider>))
    const rows = [...document.querySelectorAll<HTMLElement>('.chat-input-config-row')]
    const providerRow = rows[1]
    const modelRow = rows[2]
    await act(async () => providerRow.click())
    const option = [...document.querySelectorAll<HTMLButtonElement>('.chat-input-menu-item')]
      .find((item) => item.textContent?.includes('Managed Failed'))!
    assert.equal(option.disabled, false)
    await act(async () => option.click())
    assert.match(providerRow.textContent ?? '', /Managed Failed/)
    await act(async () => modelRow.click())
    const model = [...document.querySelectorAll<HTMLButtonElement>('.chat-input-menu-item')]
      .find((item) => item.textContent?.includes('Allowed model'))!
    await act(async () => model.click())
    assert.equal(selectedModel, 'allowed')
  } finally {
    await act(async () => root.unmount())
    providerApi.list = original.list
    engineApi.models = original.models
    await window.happyDOM.close()
  }
})

test('project changes and refreshes ignore late provider lists and share concurrent reads', async () => {
  const { window, document } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = providerApi.list
  const requests: Array<{ project: string; resolve: (result: { providers: ProviderInfo[]; types: [] }) => void }> = []
  providerApi.list = project => new Promise(resolve => requests.push({ project: project!, resolve }))
  function List({ project }: { project: string }) {
    return <output>{useProjectProviders(project).map(item => item.name).join(',')}</output>
  }
  const finish = (index: number, name: string) => requests[index].resolve({
    providers: [{ id: name, name, enabled: true } as ProviderInfo], types: [],
  })
  try {
    await act(async () => root.render(<><List project="a" /><List project="a" /></>))
    assert.equal(requests.length, 1)
    await act(async () => root.render(<><List project="b" /><List project="b" /></>))
    assert.equal(requests.length, 2)
    await act(async () => finish(1, 'current'))
    await act(async () => finish(0, 'old-project'))
    assert.equal(document.querySelector('output')!.textContent, 'current')
    await act(async () => notifyProvidersChanged())
    await act(async () => notifyProvidersChanged())
    assert.equal(requests.length, 4)
    await act(async () => finish(3, 'OpenAI'))
    await act(async () => finish(2, 'old-revision'))
    assert.equal(document.querySelector('output')!.textContent, 'OpenAI')
    assert.deepEqual(requests.map(item => item.project), ['a', 'b', 'b', 'b'])
  } finally {
    await act(async () => root.unmount())
    providerApi.list = original
    await window.happyDOM.close()
  }
})
