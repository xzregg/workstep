import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { installDomEnvironment } from './helpers/domEnv'
import Layout from '../src/components/Layout'
import { I18nProvider } from '../src/i18n'
import { useProjectStore } from '../src/stores/projectStore'
import { useChatListStore } from '../src/stores/chatSessionStore'

test('mobile header creates in the selected project directly, prevents duplicates and supports retry', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: 390, height: 844 })
  Object.assign(globalThis, { history: window.history, ResizeObserver: window.ResizeObserver })
  const oldFetch = globalThis.fetch, oldSocket = globalThis.WebSocket
  const projectState = useProjectStore.getState(), chatState = useChatListStore.getState()
  const projects = [
    { id: 'first', name: 'First', path: '/tmp/first', steps: {}, workflows: [] },
    { id: 'selected', name: '当前项目', path: '/tmp/selected', steps: {}, workflows: [] },
  ]
  class Socket {
    static OPEN = 1
    static CONNECTING = 0
    readyState = 1
    send() {}
    close() { this.readyState = 3 }
  }
  Object.assign(globalThis, { WebSocket: Socket })
  useProjectStore.setState({ projects, activeProject: projects[1], activeWorkflowId: null })
  useChatListStore.setState({ sessionsByProject: {}, listLoadingByProject: {}, listErrorByProject: {} })
  const requests: unknown[] = []
  let finish!: (response: Response) => void
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/project/list') return Response.json({ projects })
    if (String(input).includes('/chat-sessions?') && init?.method === 'POST') {
      requests.push(JSON.parse(String(init.body)))
      return new Promise<Response>(resolve => { finish = resolve })
    }
    return Response.json({ sessions: [], engines: [], providers: [], buttons: [] })
  }
  let route = ''
  function Route() { const location = useLocation(); route = location.pathname + location.search; return null }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const plus = () => document.querySelector<HTMLButtonElement>('.mobile-header-actions button')!
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter initialEntries={['/tasks']}><Layout onSelectProject={() => {}}><Route /></Layout></MemoryRouter></I18nProvider>))
    await act(async () => { plus().click(); plus().click() })
    assert.deepEqual(requests, [{ project_id: 'selected' }])
    assert.equal(route, '/tasks', 'creation must not navigate through an empty chat page')
    assert.equal(plus().disabled, true)
    assert.ok(plus().querySelector('.spinner'))
    await act(async () => finish(Response.json({ detail: '创建失败' }, { status: 500 })))
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /创建失败/)
    assert.equal(plus().disabled, false)
    await act(async () => plus().click())
    await act(async () => finish(Response.json({ id: 'created', project_id: 'selected', title: '新对话', message_count: 0 })))
    assert.equal(requests.length, 2)
    const params = new URLSearchParams(route.split('?')[1])
    assert.equal(params.get('project'), '当前项目')
    assert.equal(params.get('session'), 'created')
    assert.equal(useChatListStore.getState().sessionsByProject.selected[0].id, 'created')
    await act(async () => useProjectStore.setState({ projects: [], activeProject: null }))
    assert.equal(plus().disabled, true)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = oldFetch; globalThis.WebSocket = oldSocket
    useProjectStore.setState(projectState); useChatListStore.setState(chatState)
    await window.happyDOM.close()
  }
})
