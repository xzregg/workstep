import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider } from '../src/i18n'
import { connectorApi } from '../src/api/connectors'
import ConnectorPicker from '../src/components/connectors/ConnectorPicker'

test('connector picker disables unavailable switches and preserves account when switched off', async () => {
  const { window } = installDomEnvironment()
  const rootElement = document.body.appendChild(document.createElement('div'))
  const root = createRoot(rootElement)
  const original = { available: connectorApi.available, select: connectorApi.select }
  let ids: string[] = []
  connectorApi.available = async () => ({ connectors: [
    { id: 'github', name: 'GitHub', description: 'Issues', kind: 'mcp', selected: true, available: true },
    { id: 'cli', name: 'CLI', description: '', kind: 'cli', selected: false, available: false },
  ] })
  connectorApi.select = async (_project, _session, selected) => { ids = selected; return { ok: true } }
  try {
    await act(async () => root.render(<I18nProvider><ConnectorPicker projectId="p" sessionId="s" engineId="codex" onClose={() => {}} /></I18nProvider>))
    const switches = [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
    assert.equal(switches.length, 2)
    assert.equal(switches[1].disabled, true)
    await act(async () => switches[0].click())
    assert.deepEqual(ids, [])
    assert.match(document.body.textContent || '', /GitHub/)
  } finally {
    Object.assign(connectorApi, original)
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
