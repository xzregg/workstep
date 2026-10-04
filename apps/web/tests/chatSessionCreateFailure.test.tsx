import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { assistantApi, chatSessionApi, providerApi } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import ChatPage from '../src/pages/ChatPage'
import { useChatListStore } from '../src/stores/chatSessionStore'
import { useProjectStore } from '../src/stores/projectStore'

test('empty chat page shows create failure and allows another attempt', async () => {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const originals = {
    create: chatSessionApi.create,
    list: chatSessionApi.list,
    quickButtons: chatSessionApi.quickButtons,
    assistants: assistantApi.list,
    providers: providerApi.list,
  }
  const project = { id: 'create-failure', name: 'create-failure', path: '/tmp/create-failure', workflows: [] }
  let attempts = 0
  chatSessionApi.create = async () => {
    attempts += 1
    throw new Error('创建请求超时')
  }
  chatSessionApi.list = async () => ({ sessions: [] })
  chatSessionApi.quickButtons = async () => ({ buttons: [] })
  assistantApi.list = async () => ({ assistants: [] })
  providerApi.list = async () => ({ providers: [] })
  useProjectStore.setState({ projects: [project] as never, activeProject: project as never, loading: false })
  useChatListStore.setState({ sessionsByProject: {}, quickButtons: [], listLoadingByProject: {} })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<MemoryRouter initialEntries={['/chat?project=create-failure']}><I18nProvider><ChatPage /></I18nProvider></MemoryRouter>)
    })
    const createButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('新建对话'))
    assert.ok(createButton)
    await act(async () => { createButton.click() })
    assert.equal(attempts, 1)
    assert.match(container.textContent || '', /创建请求超时/)
    assert.equal(createButton.disabled, false)
    await act(async () => { createButton.click() })
    assert.equal(attempts, 2)
  } finally {
    await act(async () => root.unmount())
    chatSessionApi.create = originals.create
    chatSessionApi.list = originals.list
    chatSessionApi.quickButtons = originals.quickButtons
    assistantApi.list = originals.assistants
    providerApi.list = originals.providers
    await window.happyDOM.close()
  }
})

test('create request has a deadline so the loading state can recover', async () => {
  const originalFetch = globalThis.fetch
  const originalTimeout = AbortSignal.timeout
  let receivedSignal: AbortSignal | undefined
  globalThis.fetch = async (_input, init) => {
    receivedSignal = init?.signal as AbortSignal
    throw receivedSignal.reason
  }
  AbortSignal.timeout = () => AbortSignal.abort(new DOMException('Timed out', 'TimeoutError'))
  try {
    await assert.rejects(chatSessionApi.create({ project_id: 'create-failure' }), { name: 'TimeoutError' })
    assert.equal(receivedSignal?.aborted, true)
  } finally {
    globalThis.fetch = originalFetch
    AbortSignal.timeout = originalTimeout
  }
})
