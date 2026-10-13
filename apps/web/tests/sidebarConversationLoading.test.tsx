import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { installDomEnvironment } from './helpers/domEnv'
import Layout from '../src/components/Layout'
import { I18nProvider } from '../src/i18n'
import { useProjectStore } from '../src/stores/projectStore'
import { useChatListStore } from '../src/stores/chatSessionStore'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'
import { SIDEBAR_SECTION_STATE_KEY } from '../src/utils/sidebarSectionState'

for (const remote of [false, true]) test(`${remote ? 'remote' : 'local'}: expanding conversations loads that project without selecting it; collapsing does not load`, async () => {
  const { window } = installDomEnvironment()
  const oldFetch = globalThis.fetch, oldSocket = globalThis.WebSocket
  const projectState = useProjectStore.getState(), chatState = useChatListStore.getState()
  const projects = [
    { id: 'active', name: 'Active', path: '/tmp/active', steps: {}, workflows: [] },
    { id: 'other', name: 'Other', path: '/tmp/other', steps: {}, workflows: [], type: remote ? 'remote' as const : undefined },
  ]
  window.localStorage.setItem(SIDEBAR_SECTION_STATE_KEY, JSON.stringify({
    expandedProjectIds: ['other'], conversationsByProject: { other: false },
  }))
  class Socket {
    static OPEN = 1
    static CONNECTING = 0
    readyState = 1
    send() {}
    close() { this.readyState = 3 }
  }
  Object.assign(globalThis, { WebSocket: Socket, ResizeObserver: window.ResizeObserver })
  useGatewaySessionStore.setState({ session: null })
  useProjectStore.setState({ projects, activeProject: projects[0], activeWorkflowId: null })
  useChatListStore.setState({ sessionsByProject: {}, listLoadingByProject: {}, listErrorByProject: {} })
  let calls = 0
  let finish!: (response: Response) => void
  globalThis.fetch = async input => {
    const path = String(input)
    if (path === '/api/project/list') return Response.json({ projects })
    if (path.includes('/chat-sessions?project_id=other')) {
      calls++
      return new Promise<Response>(resolve => { finish = resolve })
    }
    return Response.json({ sessions: [], engines: [], providers: [], buttons: [] })
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const clickHeader = () => act(async () => container.querySelector<HTMLElement>('.layout-sidebar-session-label')!.click())
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter initialEntries={['/tasks']}><Layout onSelectProject={() => {}} /></MemoryRouter></I18nProvider>))
    assert.equal(calls, 0)
    await clickHeader()
    assert.equal(calls, 1)
    assert.ok(container.querySelector('.layout-session-list [role="status"]'))
    await clickHeader()
    assert.equal(calls, 1)
    await clickHeader()
    assert.equal(calls, 1, 'opening during an in-flight load must not duplicate requests')
    await act(async () => finish(Response.json({ sessions: [
      { id: 'loaded', title: '已加载对话', project_id: 'other', workflow_id: '', engine: 'codex', message_count: 1 },
    ] })))
    assert.match(container.querySelector('.layout-session-list')!.textContent!, /已加载对话/)
    assert.equal(useProjectStore.getState().activeProject?.id, 'active')
    await clickHeader()
    assert.equal(calls, 1)
    await clickHeader()
    assert.equal(calls, 2, 'reopening refreshes the list even when cached')
    await act(async () => finish(Response.json({ detail: 'offline' }, { status: 502 })))
    assert.ok(container.querySelector('.layout-session-list [role="alert"] button'))
    await act(async () => container.querySelector<HTMLButtonElement>('.layout-session-list [role="alert"] button')!.click())
    assert.equal(calls, 3)
    await act(async () => finish(Response.json({ sessions: [] })))
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = oldFetch; globalThis.WebSocket = oldSocket
    useProjectStore.setState(projectState); useChatListStore.setState(chatState)
    await window.happyDOM.close()
  }
})
