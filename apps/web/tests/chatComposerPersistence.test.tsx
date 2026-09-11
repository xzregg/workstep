import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import ChatPage from '../src/pages/ChatPage'
import { I18nProvider } from '../src/i18n'
import { assistantApi, chatSessionApi, engineApi, providerApi } from '../src/api/client'
import { useChatListStore, useChatSessionStore } from '../src/stores/chatSessionStore'
import { useProjectStore } from '../src/stores/projectStore'

const project = {
  id: 'project-1',
  name: 'demo',
  path: '/tmp/demo',
  workflows: [],
}

function installApiStubs(running = false) {
  const originals = {
    assistantList: assistantApi.list,
    chatGet: chatSessionApi.get,
    chatList: chatSessionApi.list,
    quickButtons: chatSessionApi.quickButtons,
    quota: engineApi.quota,
    providerList: providerApi.list,
  }
  assistantApi.list = async () => ({ assistants: [{
    name: 'chat_session',
    configured: { engine: 'claude', model: '', fast_model: '', vision_model: '', thinking_effort: '' },
    available_engines: [],
  }] }) as never
  chatSessionApi.get = async () => ({
    id: 'session-1',
    project_id: project.id,
    workflow_id: null,
    title: '会话',
    engine: 'claude',
    provider_id: '',
    model: '',
    fast_model: '',
    vision_model: '',
    permission_mode: '',
    message_count: 0,
    messages: [],
    running,
    created_at: '',
    updated_at: '',
  }) as never
  chatSessionApi.list = async () => ({ sessions: [] })
  chatSessionApi.quickButtons = async () => ({
    buttons: [{ id: 'draft', label: '填入草稿', prompt: '切页后还在' }],
  })
  engineApi.quota = async () => ({ engine_id: 'claude', supported: false, quota: null })
  providerApi.list = async () => ({ providers: [] })
  return () => {
    assistantApi.list = originals.assistantList
    chatSessionApi.get = originals.chatGet
    chatSessionApi.list = originals.chatList
    chatSessionApi.quickButtons = originals.quickButtons
    engineApi.quota = originals.quota
    providerApi.list = originals.providerList
  }
}

async function renderChat(container: HTMLElement): Promise<Root> {
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/chat?project=demo&session=session-1']}>
        <I18nProvider><ChatPage /></I18nProvider>
      </MemoryRouter>,
    )
  })
  await act(async () => { await Promise.resolve() })
  return root
}

test('chat draft survives leaving and returning to the page', async () => {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    Event: window.Event,
    InputEvent: window.InputEvent,
    HTMLElement: window.HTMLElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    requestAnimationFrame: (callback: FrameRequestCallback) => window.setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => window.clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const restoreApis = installApiStubs()
  useProjectStore.setState({ projects: [project] as never, activeProject: project as never, loading: false })
  useChatListStore.setState({ sessions: [], quickButtons: [], listLoading: false })
  useChatSessionStore.setState({ sessions: {} })
  const container = document.body.appendChild(document.createElement('div'))

  try {
    let root = await renderChat(container)
    const quickPrompt = [...document.querySelectorAll('button')]
      .find((button) => button.textContent === '填入草稿')
    assert.ok(quickPrompt)
    await act(async () => quickPrompt.click())
    assert.equal((document.querySelector('textarea') as HTMLTextAreaElement).value, '切页后还在')
    await act(async () => root.unmount())
    assert.equal(localStorage.getItem('workstep-chat-draft:project-1:session-1'), '切页后还在')

    root = await renderChat(container)
    assert.equal((document.querySelector('textarea') as HTMLTextAreaElement).value, '切页后还在')
    await act(async () => root.unmount())
  } finally {
    restoreApis()
    await window.happyDOM.close()
  }
})

test('pending inserts survive leaving and returning to the chat page', async () => {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    Event: window.Event,
    InputEvent: window.InputEvent,
    HTMLElement: window.HTMLElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    requestAnimationFrame: (callback: FrameRequestCallback) => window.setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => window.clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  localStorage.setItem('workstep-chat-draft:project-1:session-1', '待插入内容')
  const restoreApis = installApiStubs(true)
  useProjectStore.setState({ projects: [project] as never, activeProject: project as never, loading: false })
  useChatListStore.setState({ sessions: [], quickButtons: [], listLoading: false })
  useChatSessionStore.setState({ sessions: {} })
  const container = document.body.appendChild(document.createElement('div'))

  try {
    let root = await renderChat(container)
    const send = document.querySelector('button.chat-input-send') as HTMLButtonElement
    assert.ok(send)
    assert.equal((document.querySelector('textarea') as HTMLTextAreaElement).value, '待插入内容')
    await act(async () => send.click())
    assert.match(document.body.textContent || '', /待插入内容/)
    await act(async () => root.unmount())
    assert.match(
      localStorage.getItem('workstep-chat-insert-queue:project-1:session-1') || '',
      /待插入内容/,
    )

    root = await renderChat(container)
    assert.match(document.body.textContent || '', /待插入内容/)
    await act(async () => root.unmount())
  } finally {
    restoreApis()
    await window.happyDOM.close()
  }
})
