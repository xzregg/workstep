import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import ChatPage from '../src/pages/ChatPage'
import { I18nProvider } from '../src/i18n'
import { assistantApi, chatSessionApi, engineApi, providerApi } from '../src/api/client'
import { useChatListStore, useChatSessionStore } from '../src/stores/chatSessionStore'
import { useProjectStore } from '../src/stores/projectStore'
import {
  pendingInsertQueueKey,
  usePendingMessageInsertStore,
} from '../src/stores/pendingMessageInsertStore'

const project = { id: 'project-1', name: 'demo', path: '/tmp/demo', workflows: [] }

function installApiStubs() {
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
  // running: true —— 会话运行中，待插入队列才会以面板形式呈现
  chatSessionApi.get = async () => ({
    id: 'session-1', project_id: project.id, workflow_id: null, title: '会话',
    engine: 'claude', provider_id: '', model: '', fast_model: '', vision_model: '',
    permission_mode: '', message_count: 1, messages: [{
      id: 'assistant-running', role: 'assistant', content: '', status: 'running', events: [],
    }], running: true,
    created_at: '', updated_at: '',
  }) as never
  chatSessionApi.list = async () => ({ sessions: [] })
  chatSessionApi.quickButtons = async () => ({ buttons: [] })
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

test('pending-insert panel reserves space on the wrapper, not the scroller', async () => {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const restoreApis = installApiStubs()
  useProjectStore.setState({ projects: [project] as never, activeProject: project as never, loading: false })
  useChatListStore.setState({ sessionsByProject: {}, quickButtons: [], listLoadingByProject: {} })
  useChatSessionStore.setState({ sessions: {} })
  const pendingKey = pendingInsertQueueKey(project.id, 'assistant-running')
  usePendingMessageInsertStore.setState({
    queues: { [pendingKey]: [{
      id: 'insert-1', target_message_id: 'assistant-running', content: '待插入内容',
      position: 0, username: '测试用户', created_at: '', updated_at: '',
    }] },
    loaded: { [pendingKey]: true },
    loading: {},
  })

  const PANEL_HEIGHT = 96
  const MARGIN_BOTTOM = 6
  const GAP = 2
  const originalRect = window.HTMLElement.prototype.getBoundingClientRect
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const rect = originalRect.call(this)
    const height = this.getAttribute?.('role') === 'region' ? PANEL_HEIGHT : 0
    return { ...rect, height, top: 0, bottom: height } as DOMRect
  }

  const container = window.document.body.appendChild(window.document.createElement('div'))
  try {
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/chat?project=demo&session=session-1']}>
          <I18nProvider><ChatPage /></I18nProvider>
        </MemoryRouter>,
      )
    })
    await act(async () => { await Promise.resolve() })

    const panel = container.querySelector('[role="region"]')
    assert.ok(panel, '待插入面板应渲染')
    const scroller = container.querySelector('.chat-history-scroll') as HTMLElement
    assert.ok(scroller)
    const wrapper = scroller.parentElement as HTMLElement

    // 留白落在包裹 chat-history-scroll 的 div 上：面板高度 + marginBottom + 间隙
    assert.equal(
      wrapper.style.paddingBottom,
      `${PANEL_HEIGHT + MARGIN_BOTTOM + GAP}px`,
    )
    // 滚动容器自身保持常规内边距（paddingBlock 为逻辑属性），不承载留白
    assert.equal(scroller.style.paddingBlock, '10px')
    assert.equal(scroller.style.paddingBottom, '')

    await act(async () => root.unmount())
  } finally {
    window.HTMLElement.prototype.getBoundingClientRect = originalRect
    restoreApis()
    await window.happyDOM.close()
  }
})
