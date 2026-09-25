import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { providerApi, taskApi, type CoordinatorConfig } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import { useTaskCoordinatorConfig } from '../src/hooks/useTaskCoordinatorConfig'

test('task coordinator configuration loads once and preserves the right fields when engine changes', async () => {
  const { window } = installDomEnvironment()
  const originalLoad = taskApi.coordinatorConfig
  const originalUpdate = taskApi.updateCoordinatorConfig
  const originalProviders = providerApi.list
  const config = {
    configured: { engine: 'pydantic_ai', model: 'model', fast_model: 'fast', vision_model: 'vision',
      thinking_effort: 'medium', provider_id: 'provider' },
    resolved: { engine: 'pydantic_ai', model: 'model', fast_model: 'fast', vision_model: 'vision',
      thinking_effort: 'medium', provider_id: 'provider' },
    available_engines: [],
  } as CoordinatorConfig
  const calls: unknown[][] = []
  taskApi.coordinatorConfig = async (...args) => { calls.push(['load', ...args]); return config }
  taskApi.updateCoordinatorConfig = async (...args) => {
    calls.push(['save', ...args])
    const selected = { engine: args[2], model: args[3], fast_model: args[4],
      vision_model: args[5], thinking_effort: args[6], provider_id: args[7] }
    return { configured: selected, resolved: { ...selected, engine: selected.engine || config.resolved.engine } }
  }
  providerApi.list = async () => ({ providers: [] }) as Awaited<ReturnType<typeof providerApi.list>>
  let current: ReturnType<typeof useTaskCoordinatorConfig>
  function Harness() { current = useTaskCoordinatorConfig('task', 'project'); return null }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    assert.deepEqual(calls[0], ['load', 'task', 'project'])
    assert.equal(calls.filter((call) => call[0] === 'load').length, 1)
    await act(async () => current.onEngineChange('codex'))
    assert.deepEqual(calls[1], ['save', 'task', 'project', 'codex', null, null, null, 'medium', null])
    assert.equal(current.config?.configured.engine, 'codex')
    assert.equal(current.notice?.length > 0, true)
    await act(async () => current.onModelChange('new-model'))
    assert.deepEqual(calls[2], ['save', 'task', 'project', 'codex', 'new-model', null, null, 'medium', null])
    await act(async () => current.onThinkingEffortChange('high'))
    assert.deepEqual(calls[3], ['save', 'task', 'project', 'codex', 'new-model', null, null, 'high', null])
  } finally {
    await act(async () => root.unmount())
    taskApi.coordinatorConfig = originalLoad
    taskApi.updateCoordinatorConfig = originalUpdate
    providerApi.list = originalProviders
    container.remove()
    await window.happyDOM.close()
  }
})
