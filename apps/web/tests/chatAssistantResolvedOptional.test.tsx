import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import ChatPage from '../src/pages/ChatPage'
import { I18nProvider } from '../src/i18n'
import { digitalPersonApi, digitalRuntimeApi } from '../src/api/digitalPerson'
import { assistantApi, chatSessionApi, engineApi, providerApi } from '../src/api/client'
import { useChatListStore, useChatSessionStore } from '../src/stores/chatSessionStore'
import { useProjectStore } from '../src/stores/projectStore'

const project = {
  id: 'project-optional-resolved',
  name: 'optional-resolved',
  path: '/tmp/optional-resolved',
  workflows: [],
}

for (const isDefaultWorkspace of [false, true]) test(`chat page uses ordinary defaults with default workspace=${isDefaultWorkspace}`, async () => {
  const currentProject = { ...project, is_default_workspace: isDefaultWorkspace }
  const window = new Window({ url: 'http://localhost/' })
  window.innerWidth = 1440
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
  const originals = {
    assistantList: assistantApi.list,
    digitalGet: digitalPersonApi.get,
    digitalActivity: digitalRuntimeApi.activity,
    chatGet: chatSessionApi.get,
    chatList: chatSessionApi.list,
    quickButtons: chatSessionApi.quickButtons,
    quota: engineApi.quota,
    providerList: providerApi.list,
    markRead: chatSessionApi.markRead,
  }
  digitalPersonApi.get = async () => ({ enabled: true, name: '数字中枢', greeting: '你好' }) as never
  digitalRuntimeApi.activity = async () => ({ main_session_id: 'main', runs: [], delegations: [] }) as never
  assistantApi.list = async () => ({
    assistants: [{
      name: 'chat_session',
      channel: 'session_chat',
      scope: 'chat',
      engine_label: 'Chat engine',
      fields: ['engine', 'model', 'fast_model', 'vision_model', 'thinking_effort', 'provider_id'],
      configured: {
        engine: 'codex_sdk',
        model: '',
        fast_model: '',
        vision_model: '',
        thinking_effort: 'minimal',
        provider_id: '',
      },
      available_engines: [],
    }],
  }) as never
  chatSessionApi.get = async (sessionId: string) => ({
    id: sessionId,
    project_id: project.id,
    workflow_id: null,
    title: '会话',
    engine: 'codex_sdk',
    provider_id: '',
    model: '',
    fast_model: '',
    vision_model: '',
    permission_mode: '',
    message_count: 1,
    messages: [{
      id: 'answer', role: 'assistant', content: '这是普通对话回复', status: 'succeeded',
      engine: 'codex_sdk', model: 'gpt-6-luna', created_at: '2026-11-25T00:00:00Z',
      events: [{ type: 'usage_update', data: { input_tokens: 29245, output_tokens: 58 } }],
    }],
    running: false,
    created_at: '',
    updated_at: '',
  }) as never
  chatSessionApi.markRead = async () => ({}) as never
  chatSessionApi.list = async () => ({ sessions: [] })
  chatSessionApi.quickButtons = async () => ({ buttons: [] })
  engineApi.quota = async () => ({ engine_id: 'codex_sdk', supported: false, quota: null })
  providerApi.list = async () => ({ providers: [] })
  useProjectStore.setState({
    projects: [currentProject] as never,
    activeProject: currentProject as never,
    loading: false,
  })
  useChatListStore.setState({ sessionsByProject: {}, quickButtons: [], listLoadingByProject: {} })
  useChatSessionStore.setState({ sessions: {} })

  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/chat?project=optional-resolved&session=session-1']}>
          <I18nProvider><ChatPage /></I18nProvider>
        </MemoryRouter>,
      )
    })
    await act(async () => { await Promise.resolve() })
    assert.match(container.textContent || '', /默认（极简）/)
    const footer = container.querySelector('.message-response-footer')
    assert.ok(Boolean(footer))
    assert.equal(Boolean(footer?.querySelector('details')), false, 'desktop conversations show usage inline even with feedback actions')
    assert.match(footer?.querySelector('.footer-usage-summary')?.textContent || '', /29,245/)
    assert.match(footer?.textContent || '', /gpt-6-luna/)
  } finally {
    await act(async () => root.unmount())
    digitalPersonApi.get = originals.digitalGet
    digitalRuntimeApi.activity = originals.digitalActivity
    assistantApi.list = originals.assistantList
    chatSessionApi.get = originals.chatGet
    chatSessionApi.list = originals.chatList
    chatSessionApi.quickButtons = originals.quickButtons
    engineApi.quota = originals.quota
    providerApi.list = originals.providerList
    chatSessionApi.markRead = originals.markRead
    await window.happyDOM.close()
  }
})

test('chat page shows the resolved engine default when no session override exists', async () => {
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
  const originals = {
    assistantList: assistantApi.list,
    chatGet: chatSessionApi.get,
    chatList: chatSessionApi.list,
    quickButtons: chatSessionApi.quickButtons,
    quota: engineApi.quota,
    providerList: providerApi.list,
  }
  assistantApi.list = async () => ({
    assistants: [{
      name: 'chat_session',
      channel: 'session_chat',
      scope: 'chat',
      engine_label: 'Chat engine',
      fields: ['engine', 'model', 'fast_model', 'vision_model', 'thinking_effort', 'provider_id'],
      configured: {
        engine: '',
        model: '',
        fast_model: '',
        vision_model: '',
        thinking_effort: '',
        provider_id: '',
      },
      resolved: {
        engine: 'codex_sdk',
        model: '',
        fast_model: '',
        vision_model: '',
        thinking_effort: 'minimal',
        provider_id: '',
      },
      available_engines: [],
    }],
  }) as never
  chatSessionApi.get = async (sessionId: string) => ({
    id: sessionId,
    project_id: project.id,
    workflow_id: null,
    title: '会话',
    engine: '',
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
  chatSessionApi.list = async () => ({ sessions: [] })
  chatSessionApi.quickButtons = async () => ({ buttons: [] })
  engineApi.quota = async () => ({ engine_id: 'codex_sdk', supported: false, quota: null })
  providerApi.list = async () => ({ providers: [] })
  useProjectStore.setState({
    projects: [project] as never,
    activeProject: project as never,
    loading: false,
  })
  useChatListStore.setState({ sessionsByProject: {}, quickButtons: [], listLoadingByProject: {} })
  useChatSessionStore.setState({ sessions: {} })
  localStorage.removeItem(`workstep-chat-engine-config:${project.id}:session-1`)

  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/chat?project=optional-resolved&session=session-1']}>
          <I18nProvider><ChatPage /></I18nProvider>
        </MemoryRouter>,
      )
    })
    await act(async () => { await Promise.resolve() })
    assert.match(container.textContent || '', /默认（极简）/)
    assert.match(container.querySelector('[data-kind="config"] .chat-input-config-engine')?.textContent || '', /Codex/)
  } finally {
    await act(async () => root.unmount())
    assistantApi.list = originals.assistantList
    chatSessionApi.get = originals.chatGet
    chatSessionApi.list = originals.chatList
    chatSessionApi.quickButtons = originals.quickButtons
    engineApi.quota = originals.quota
    providerApi.list = originals.providerList
    await window.happyDOM.close()
  }
})

test('new chat sessions inherit the chat assistant settings', async () => {
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
  const originals = {
    assistantList: assistantApi.list,
    chatCreate: chatSessionApi.create,
    chatGet: chatSessionApi.get,
    chatList: chatSessionApi.list,
    quickButtons: chatSessionApi.quickButtons,
    quota: engineApi.quota,
    providerList: providerApi.list,
  }
  assistantApi.list = async () => ({
    assistants: [{
      name: 'chat_session',
      channel: 'session_chat',
      scope: 'chat',
      engine_label: 'Chat engine',
      fields: ['engine', 'model', 'fast_model', 'vision_model', 'thinking_effort', 'provider_id'],
      configured: {
        engine: 'codex_sdk',
        model: 'gpt-6-codex',
        fast_model: 'gpt-6-fast',
        vision_model: 'gpt-6-vision',
        thinking_effort: 'minimal',
        provider_id: 'prov-1',
      },
      resolved: {
        engine: 'codex_sdk',
        model: 'gpt-6-codex',
        fast_model: 'gpt-6-fast',
        vision_model: 'gpt-6-vision',
        thinking_effort: 'minimal',
        provider_id: 'prov-1',
      },
      available_engines: [],
    }],
  }) as never
  let created: Record<string, unknown> | null = null
  chatSessionApi.create = async (input) => {
    created = input as Record<string, unknown>
    return {
      id: 'new-session',
      project_id: project.id,
      workflow_id: null,
      title: '',
      engine: 'codex_sdk',
      provider_id: 'prov-1',
      model: 'gpt-6-codex',
      fast_model: 'gpt-6-fast',
      vision_model: 'gpt-6-vision',
      permission_mode: '',
      message_count: 0,
      messages: [],
      running: false,
      created_at: '',
      updated_at: '',
    } as never
  }
  chatSessionApi.get = async (sessionId: string) => ({
    id: sessionId,
    project_id: project.id,
    workflow_id: null,
    title: '旧会话',
    engine: 'claude',
    provider_id: '',
    model: 'old-model',
    fast_model: 'old-fast',
    vision_model: 'old-vision',
    permission_mode: '',
    message_count: 0,
    messages: [],
    running: false,
    created_at: '',
    updated_at: '',
  }) as never
  chatSessionApi.list = async () => ({ sessions: [] })
  chatSessionApi.quickButtons = async () => ({ buttons: [] })
  engineApi.quota = async () => ({ engine_id: 'codex_sdk', supported: false, quota: null })
  providerApi.list = async () => ({
    providers: [{
      id: 'prov-1',
      name: 'Provider',
      type: 'custom',
      protocol: 'openai_responses',
      base_url: '',
      enabled: true,
      model_count: 0,
    }],
  })
  useProjectStore.setState({
    projects: [project] as never,
    activeProject: project as never,
    loading: false,
  })
  useChatListStore.setState({ sessionsByProject: {}, quickButtons: [], listLoadingByProject: {} })
  useChatSessionStore.setState({ sessions: {} })

  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/chat?project=optional-resolved&session=old-session']}>
          <I18nProvider><ChatPage /></I18nProvider>
        </MemoryRouter>,
      )
    })
    await act(async () => { await Promise.resolve() })
    const newSessionButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('新建对话'))
    assert.ok(newSessionButton)
    await act(async () => {
      newSessionButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    assert.deepEqual(created, {
      project_id: project.id,
      engine: 'codex_sdk',
      provider_id: 'prov-1',
      model: 'gpt-6-codex',
      fast_model: 'gpt-6-fast',
      vision_model: 'gpt-6-vision',
    })
  } finally {
    await act(async () => root.unmount())
    assistantApi.list = originals.assistantList
    chatSessionApi.create = originals.chatCreate
    chatSessionApi.get = originals.chatGet
    chatSessionApi.list = originals.chatList
    chatSessionApi.quickButtons = originals.quickButtons
    engineApi.quota = originals.quota
    providerApi.list = originals.providerList
    await window.happyDOM.close()
  }
})
