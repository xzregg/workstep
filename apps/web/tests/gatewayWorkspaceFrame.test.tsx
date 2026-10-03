import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import GatewayRemoteFrame from '../src/components/GatewayRemoteFrame'
import { I18nProvider } from '../src/i18n'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'
import { useProjectStore } from '../src/stores/projectStore'

test('workspace waits for its session and project, then removes content after session loss', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('http://d-device-1.localhost:8700/')
  const oldFetch = globalThis.fetch
  let fail = false
  const calls: string[] = []
  globalThis.fetch = async input => {
    const path = String(input)
    calls.push(path)
    if (path === '/api/remote/session') return fail ? Response.json({}, { status: 401 }) : Response.json({
      device_id: 'device-1', device_name: 'PC', username: 'Alice',
      gateway_url: 'http://localhost:8700/devices', project_id: 'platform-1',
      host_project_id: 'host-1', access_level: 'read', task_create: false,
    })
    if (path === '/api/project/host-1/summary') return Response.json({
      id: 'host-1', name: 'Visible', workflows: [], steps: {},
    })
    throw new Error(`Unexpected ${path}`)
  }
  useGatewaySessionStore.setState({ session: null, error: '', loading: false })
  useProjectStore.setState({ projects: [], activeProject: null, activeWorkflowId: null })
  const element = document.body.appendChild(document.createElement('div'))
  const root = createRoot(element)
  try {
    await act(async () => root.render(<I18nProvider><GatewayRemoteFrame>
      <div data-workspace>Full existing workspace</div>
    </GatewayRemoteFrame></I18nProvider>))
    assert.ok(element.querySelector('[data-workspace]'))
    assert.deepEqual(calls, ['/api/remote/session', '/api/project/host-1/summary'])
    assert.equal(useProjectStore.getState().activeProject?.id, 'host-1')
    assert.equal(element.querySelector('a')?.getAttribute('href'), 'http://localhost:8700/devices')
    fail = true
    await act(async () => { await assert.rejects(useGatewaySessionStore.getState().load(true)) })
    // The shared session state must revoke content immediately, before the next poll.
    assert.equal(element.querySelector('[data-workspace]'), null)
  } finally {
    await act(async () => root.unmount())
    element.remove()
    globalThis.fetch = oldFetch
    useGatewaySessionStore.setState({ session: null, error: '', loading: false })
    useProjectStore.setState({ projects: [], activeProject: null, activeWorkflowId: null })
    await window.happyDOM.close()
  }
})
