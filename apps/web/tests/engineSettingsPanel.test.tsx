import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { engineApi } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import EngineSettingsPanel from '../src/components/EngineSettingsPanel'

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
