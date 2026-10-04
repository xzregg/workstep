import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../src/App'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'
import { useProjectStore } from '../src/stores/projectStore'

test('the real WorkStep app opens the bound task workspace and subscribes within that project', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('http://d-device-1.localhost:8700/')
  useLocaleStore.setState({ locale: 'zh-CN' })
  const oldFetch = globalThis.fetch
  const oldSocket = globalThis.WebSocket
  const calls: string[] = []
  const subscriptions: { project_id?: string }[] = []
  class Socket {
    static OPEN = 1
    static CONNECTING = 0
    readyState = 1
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    constructor(url: string) {
      assert.equal(url, 'ws://d-device-1.localhost:8700/ws')
      queueMicrotask(() => this.onopen?.())
    }
    send(message: string) { subscriptions.push(JSON.parse(message)) }
    close() { this.readyState = 3; this.onclose?.() }
  }
  Object.assign(globalThis, { WebSocket: Socket, ResizeObserver: window.ResizeObserver })
  globalThis.fetch = async input => {
    const path = String(input)
    calls.push(path)
    if (path === '/api/remote/session') return Response.json({
      device_id: 'device-1', device_name: 'PC', username: 'Alice', gateway_url: 'http://localhost:8700/devices',
      project_id: 'platform-1', host_project_id: 'host-1', access_level: 'read', task_create: false,
    })
    if (path === '/api/project/host-1/summary') return Response.json({
      id: 'host-1', name: 'Visible', steps: { steps: [], connections: [] },
      workflows: [{ id: 'flow-1', name: 'Flow', is_default: true, nodeCount: 0 }],
    })
    if (path.startsWith('/api/task/list?project_id=host-1')) return Response.json({ tasks: [] })
    if (path.startsWith('/api/chat-sessions?project_id=host-1')) return Response.json({ sessions: [] })
    return Response.json({ detail: 'project scope denied' }, { status: 403 })
  }
  useGatewaySessionStore.setState({ session: null, error: '', loading: false })
  useProjectStore.setState({ projects: [], activeProject: null, activeWorkflowId: null })
  const element = document.body.appendChild(document.createElement('div'))
  const root = createRoot(element)
  try {
    await act(async () => root.render(<I18nProvider><App /></I18nProvider>))
    assert.ok(element.querySelector('.app-shell'))
    assert.equal(window.location.pathname, '/tasks')
    assert.equal(new URLSearchParams(window.location.search).get('project'), 'Visible')
    assert.equal(new URLSearchParams(window.location.search).get('workflow'), 'flow-1')
    assert.equal(useProjectStore.getState().activeProject?.id, 'host-1')
    assert.equal(calls.includes('/api/project/list'), false)
    assert.equal(calls.filter(path => path === '/api/project/host-1/summary').length, 1)
    assert.ok(subscriptions.some(subscription => subscription.project_id === 'host-1'))
    assert.equal(element.querySelector('.mobile-task-new-button'), null)
    assert.equal(element.querySelector('.task-board-lane-add'), null)
    assert.equal([...element.querySelectorAll('button')].some(button => button.textContent?.trim() === '新建任务'), false)
  } finally {
    await act(async () => root.unmount())
    element.remove()
    globalThis.fetch = oldFetch
    globalThis.WebSocket = oldSocket
    useGatewaySessionStore.setState({ session: null, error: '', loading: false })
    useProjectStore.setState({ projects: [], activeProject: null, activeWorkflowId: null })
    await window.happyDOM.close()
  }
})
