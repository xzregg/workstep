import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import Layout from '../src/components/Layout'
import ChatPage from '../src/pages/ChatPage'
import { I18nProvider } from '../src/i18n'
import {
  assistantApi,
  chatSessionApi,
  engineApi,
  projectApi,
  providerApi,
  workflowApi,
  type Project,
} from '../src/api/client'
import { useChatListStore, useChatSessionStore } from '../src/stores/chatSessionStore'
import { useProjectStore } from '../src/stores/projectStore'
import { installDomEnvironment } from './helpers/domEnv'

const project = {
  id: 'project-1',
  name: 'demo',
  path: '/tmp/demo',
  steps: {},
  workflows: [
    { id: 'wf-1', name: '流程 A', is_default: true, nodeCount: 0 },
    { id: 'wf-2', name: '流程 B', is_default: false, nodeCount: 0 },
  ],
} as Project

function installStubs() {
  const originals = {
    assistantList: assistantApi.list,
    chatGet: chatSessionApi.get,
    chatList: chatSessionApi.list,
    quickButtons: chatSessionApi.quickButtons,
    providerList: providerApi.list,
    quota: engineApi.quota,
    projectList: projectApi.list,
    workflowGet: workflowApi.get,
  }
  assistantApi.list = async () => ({ assistants: [{
    name: 'chat_session',
    configured: { engine: 'claude', model: '', fast_model: '', vision_model: '', thinking_effort: '' },
    available_engines: [],
  }] }) as never
  chatSessionApi.get = async (sessionId: string) => ({
    id: sessionId,
    project_id: project.id,
    workflow_id: null,
    title: '会话 A',
    engine: 'claude',
    provider_id: '',
    model: '',
    fast_model: '',
    vision_model: '',
    permission_mode: '',
    message_count: 0,
    messages: [],
    running: false,
    created_at: '',
    updated_at: '',
  }) as never
  chatSessionApi.list = async () => ({ sessions: [{
    id: 'session-1',
    project_id: project.id,
    workflow_id: null,
    title: '会话 A',
    engine: 'claude',
    model: '',
    message_count: 0,
    created_at: '',
    updated_at: '',
  }] })
  chatSessionApi.quickButtons = async () => ({ buttons: [] })
  providerApi.list = async () => ({ providers: [] })
  engineApi.quota = async () => ({ engine_id: 'claude', supported: false, quota: null })
  projectApi.list = async () => ({ projects: [project] })
  workflowApi.get = async (workflowId: string) => ({
    id: workflowId,
    name: workflowId === 'wf-2' ? '流程 B' : '流程 A',
    is_default: workflowId === 'wf-1',
    steps: {},
  }) as never
  return () => {
    assistantApi.list = originals.assistantList
    chatSessionApi.get = originals.chatGet
    chatSessionApi.list = originals.chatList
    chatSessionApi.quickButtons = originals.quickButtons
    providerApi.list = originals.providerList
    engineApi.quota = originals.quota
    projectApi.list = originals.projectList
    workflowApi.get = originals.workflowGet
  }
}

function setNativeValue(element: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!
    .set!
    .call(element, value)
}

test('chat draft survives the real sidebar workflow round trip in the same project', async () => {
  const { window, document } = installDomEnvironment()
  const restoreApis = installStubs()
  const originalWebSocket = globalThis.WebSocket
  class FakeWebSocket {
    static OPEN = 1
    onopen: (() => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: (() => void) | null = null
    onclose: (() => void) | null = null
    readyState = FakeWebSocket.OPEN
    send() {}
    close() {}
  }
  Object.assign(globalThis, { WebSocket: FakeWebSocket })
  useProjectStore.setState({
    projects: [project],
    activeProject: project,
    activeWorkflowId: 'wf-1',
    loading: false,
  })
  useChatListStore.setState({
    sessionsByProject: {
      [project.id]: [{
        id: 'session-1',
        project_id: project.id,
        workflow_id: '',
        title: '会话 A',
        engine: 'claude',
        model: '',
        message_count: 0,
        created_at: '',
        updated_at: '',
      }],
    },
    quickButtons: [],
    listLoadingByProject: {},
  })
  useChatSessionStore.setState({ sessions: {} })
  const root = createRoot(document.body.appendChild(document.createElement('div')))

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <MemoryRouter initialEntries={['/chat?project=demo&session=session-1']}>
            <Layout onSelectProject={() => {}}>
              <Routes>
                <Route path="/chat" element={<ChatPage />} />
                <Route path="/tasks" element={<div>任务页</div>} />
              </Routes>
            </Layout>
          </MemoryRouter>
        </I18nProvider>,
      )
    })
    await act(async () => { await Promise.resolve() })
    const projectToggle = document.querySelector<HTMLButtonElement>(
      '#workstep-navigation [aria-controls="sidebar-project-project-1"]',
    )
    assert.ok(projectToggle, document.body.textContent || '')
    await act(async () => projectToggle.click())
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    assert.ok(textarea)
    await act(async () => {
      setNativeValue(textarea, '切流程还要回来')
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
    })

    const clickSidebarRow = async (text: string) => {
      const row = [...document.querySelectorAll<HTMLElement>('.ws-row')]
        .find((item) => item.textContent?.includes(text))
      assert.ok(row, `sidebar row ${text} exists`)
      await act(async () => {
        row.click()
        await Promise.resolve()
      })
    }

    await clickSidebarRow('流程 B')
    assert.match(document.body.textContent || '', /任务页/)
    const sessionSection = [...document.querySelectorAll<HTMLElement>('#workstep-navigation div')]
      .find((item) => item.textContent?.trim() === '会话')
    assert.ok(sessionSection)
    await act(async () => sessionSection.click())
    await clickSidebarRow('会话 A')
    await act(async () => { await Promise.resolve() })

    assert.equal(
      (document.querySelector('textarea') as HTMLTextAreaElement).value,
      '切流程还要回来',
    )
  } finally {
    await act(async () => root.unmount())
    restoreApis()
    globalThis.WebSocket = originalWebSocket
    await window.happyDOM.close()
  }
})
