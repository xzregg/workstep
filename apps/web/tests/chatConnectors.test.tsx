import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider } from '../src/i18n'
import { connectorApi, CONNECTORS_CHANGED } from '../src/api/connectors'
import { useChatConnectors } from '../src/components/connectors/useChatConnectors'

test('session connectors fetch once, slash opens the shared picker, removing preserves configuration', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...connectorApi }
  let reads = 0, cleared = '', selected: string[] = ['one']
  connectorApi.available = async (project, session) => {
    assert.equal(project, 'project'); assert.equal(session, 'task:task')
    reads++
    return { connectors: [{ id: 'one', name: 'Demo', kind: 'mcp', description: 'One line', selected: true, available: true }] }
  }
  connectorApi.select = async (_project, _session, ids) => { selected = ids; return { ok: true } }
  const change = (value: string) => { cleared = value }
  function Harness({ value = '', enabled = true }) {
    const connectors = useChatConnectors({ enabled, projectId: 'project', sessionId: 'task:task', engineId: 'codex', locked: false, value, onChange: change })
    return <>{connectors.tags}{connectors.control}</>
  }
  try {
    await act(async () => root.render(<I18nProvider><Harness enabled={false} /></I18nProvider>))
    assert.equal(reads, 0)
    await act(async () => root.render(<I18nProvider><Harness value="/连接器" /></I18nProvider>))
    assert.equal(reads, 1)
    assert.equal(cleared, '')
    assert.equal(document.querySelectorAll('[role=switch]').length, 1)
    assert.equal(reads, 1, 'opening picker shares loaded catalog')
    await act(async () => document.querySelector<HTMLButtonElement>('.connector-tags button')!.click())
    assert.deepEqual(selected, [])
    assert.equal(document.querySelectorAll('.connector-tag').length, 0)
    assert.equal(document.querySelectorAll('[role=switch]').length, 1, 'configured connector remains available')
    await act(async () => window.dispatchEvent(new window.CustomEvent(CONNECTORS_CHANGED)))
    assert.equal(reads, 2, 'management changes refresh this session without reopening it')
  } finally {
    Object.assign(connectorApi, original)
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
