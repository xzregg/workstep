import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider } from '../src/i18n'
import { connectorApi } from '../src/api/connectors'
import ConnectorSettingsPanel from '../src/components/connectors/ConnectorSettingsPanel'

test('connector overview separates added cards, browse templates and local discovery tabs', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...connectorApi }
  connectorApi.list = async () => ({ connectors: [{ id: 'one', name: 'GitHub CLI', description: '管理代码与 Issue', kind: 'cli', transport: 'stdio', command: 'gh', args: [], url: '', project_ids: ['demo'], enabled: true, revision: 1, has_credentials: false, header_names: [], env_names: [] }] })
  let scans = 0
  connectorApi.scan = async () => { scans++; return { items: [{ id: 'local', name: '本机 MCP', source: '/demo/config.toml', kind: 'mcp', transport: 'stdio', command: 'node', requires_credentials: true }] } }
  try {
    await act(async () => root.render(<I18nProvider><ConnectorSettingsPanel /></I18nProvider>))
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')]
    assert.equal(tabs.length, 3)
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true')
    assert.match(document.querySelector('.connector-card')!.textContent!, /GitHub CLI/)
    assert.ok(document.querySelector('.connector-card-kind'))
    await act(async () => tabs[1].click())
    assert.equal(document.querySelectorAll('.connector-template-card').length, 3)
    await act(async () => tabs[2].click())
    assert.equal(document.querySelectorAll('.connector-card').length, 0)
    assert.equal(scans, 0)
    await act(async () => document.querySelector<HTMLButtonElement>('.connector-scan-intro button')!.click())
    assert.equal(scans, 1)
    assert.match(document.querySelector('.connector-discovery-card')!.textContent!, /本机 MCP/)
    assert.equal(document.querySelectorAll('.connector-card').length, 1)
    await act(async () => tabs[0].click())
    assert.equal(document.querySelector('.connector-discovery-card'), null)
    assert.match(document.querySelector('.connector-card')!.textContent!, /GitHub CLI/)
  } finally {
    Object.assign(connectorApi, original)
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
