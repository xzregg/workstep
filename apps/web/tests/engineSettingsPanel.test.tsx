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
