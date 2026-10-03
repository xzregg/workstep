import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import ChatPage from '../src/pages/ChatPage'
import { I18nProvider } from '../src/i18n'
import { assistantApi, chatSessionApi, engineApi, providerApi } from '../src/api/client'
import { useChatListStore, useChatSessionStore } from '../src/stores/chatSessionStore'
import { useProjectStore } from '../src/stores/projectStore'
import { clearTaskDraft, loadTaskDraft, saveTaskDraft } from '../src/utils/chatDraft'

const project = {
  id: 'project-1',
  name: 'demo',
  path: '/tmp/demo',
  workflows: [],
}

const otherProject = {
  id: 'project-2',
  name: 'other',
  path: '/tmp/other',
  workflows: [{ id: 'wf-2', name: '其他流程', is_default: true, nodeCount: 0 }],
}

test('task drafts are stored per task id', () => {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, { localStorage: window.localStorage })
  try {
    saveTaskDraft('task-a', '任务 A 草稿')
    saveTaskDraft('task-b', '任务 B 草稿')
    assert.equal(loadTaskDraft('task-a'), '任务 A 草稿')
    assert.equal(loadTaskDraft('task-b'), '任务 B 草稿')

    saveTaskDraft('task-a', '')
    assert.equal(loadTaskDraft('task-a'), '')
    assert.equal(loadTaskDraft('task-b'), '任务 B 草稿')

    clearTaskDraft('task-b')
    assert.equal(loadTaskDraft('task-b'), '')
  } finally {
    void window.happyDOM.close()
  }
})

function installApiStubs(
  running = false,
  onPermissionUpdate?: (mode: string) => void,
) {
  const originals = {
    assistantList: assistantApi.list,
    chatGet: chatSessionApi.get,
    chatList: chatSessionApi.list,
    chatSend: chatSessionApi.chat,
    quickButtons: chatSessionApi.quickButtons,
    quota: engineApi.quota,
    providerList: providerApi.list,
    updatePermission: chatSessionApi.updatePermissionMode,
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
  chatSessionApi.chat = async () => ({
    session_id: 'session-1',
    accepted: true,
  }) as never
  chatSessionApi.quickButtons = async () => ({
    buttons: [{ id: 'draft', label: '填入草稿', prompt: '切页后还在' }],
  })
  chatSessionApi.updatePermissionMode = async (_sessionId, _projectId, mode) => {
    onPermissionUpdate?.(mode)
    return { permission_mode: mode } as never
  }
  engineApi.quota = async () => ({ engine_id: 'claude', supported: false, quota: null })
  providerApi.list = async () => ({ providers: [] })
  return () => {
    assistantApi.list = originals.assistantList
    chatSessionApi.get = originals.chatGet
    chatSessionApi.list = originals.chatList
    chatSessionApi.chat = originals.chatSend
    chatSessionApi.quickButtons = originals.quickButtons
    engineApi.quota = originals.quota
    providerApi.list = originals.providerList
    chatSessionApi.updatePermissionMode = originals.updatePermission
  }
}

function ChatRouteHarnessWithoutProject() {
  return (
    <>
      <button type="button" id="switch-other-project" onClick={() => useProjectStore.setState({ activeProject: otherProject as never })}>切其他项目</button>
      <button type="button" id="switch-back-project" onClick={() => useProjectStore.setState({ activeProject: project as never })}>切回原项目</button>
      <Routes>
        <Route path="/chat" element={<ChatPage />} />
      </Routes>
    </>
  )
}

function ChatRouteHarness() {
  const navigate = useNavigate()
  return (
    <>
      <button type="button" id="go-tasks" onClick={() => navigate('/tasks?project=demo&workflow=wf-1')}>去流程</button>
      <button type="button" id="go-chat" onClick={() => navigate('/chat?project=demo&session=session-1')}>回对话</button>
      <button type="button" id="go-other-project" onClick={() => useProjectStore.setState({ activeProject: otherProject as never })}>切项目</button>
      <Routes>
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/tasks" element={<div>任务页</div>} />
      </Routes>
    </>
  )
}

function ChatSessionSwitchHarness() {
  const navigate = useNavigate()
  return (
    <>
      <button type="button" id="go-session-a" onClick={() => navigate('/chat?project=demo&session=session-a')}>会话 A</button>
      <button type="button" id="go-session-b" onClick={() => navigate('/chat?project=demo&session=session-b')}>会话 B</button>
      <Routes>
        <Route path="/chat" element={<ChatPage />} />
      </Routes>
    </>
  )
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
  useChatListStore.setState({ sessionsByProject: {}, quickButtons: [], listLoadingByProject: {} })
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
    assert.equal(localStorage.getItem('workstep-chat-draft:session-1'), '切页后还在')

    root = await renderChat(container)
    assert.equal((document.querySelector('textarea') as HTMLTextAreaElement).value, '切页后还在')
    await act(async () => root.unmount())
  } finally {
    restoreApis()
    await window.happyDOM.close()
  }
})

test('chat draft survives switching to another workflow and back', async () => {
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
  useChatListStore.setState({ sessionsByProject: {}, quickButtons: [], listLoadingByProject: {} })
  useChatSessionStore.setState({ sessions: {} })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/chat?project=demo&session=session-1']}>
          <I18nProvider><ChatRouteHarness /></I18nProvider>
        </MemoryRouter>,
      )
    })
    await act(async () => { await Promise.resolve() })
    const quickPrompt = [...document.querySelectorAll('button')]
      .find((button) => button.textContent === '填入草稿')
    assert.ok(quickPrompt)
    await act(async () => quickPrompt.click())
    assert.equal((document.querySelector('textarea') as HTMLTextAreaElement).value, '切页后还在')
    assert.equal(
      localStorage.getItem('workstep-chat-draft:session-1'),
      '切页后还在',
      'draft must be persisted before the route unmounts',
    )

    await act(async () => {
      (document.querySelector('#go-tasks') as HTMLButtonElement).click()
    })
    assert.match(document.body.textContent || '', /任务页/)
    await act(async () => {
      (document.querySelector('#go-chat') as HTMLButtonElement).click()
    })
    await act(async () => { await Promise.resolve() })

    assert.equal((document.querySelector('textarea') as HTMLTextAreaElement).value, '切页后还在')
  } finally {
    await act(async () => root.unmount())
    restoreApis()
    await window.happyDOM.close()
  }
})

test('chat draft survives switching project while a workflow is selected', async () => {
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
  useProjectStore.setState({
    projects: [project, otherProject] as never,
    activeProject: project as never,
    activeWorkflowId: null,
    loading: false,
  })
  useChatListStore.setState({ sessionsByProject: {}, quickButtons: [], listLoadingByProject: {} })
  useChatSessionStore.setState({ sessions: {} })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/chat?project=demo&session=session-1']}>
          <I18nProvider><ChatRouteHarness /></I18nProvider>
        </MemoryRouter>,
      )
    })
    await act(async () => { await Promise.resolve() })
    const quickPrompt = [...document.querySelectorAll('button')]
      .find((button) => button.textContent === '填入草稿')
    assert.ok(quickPrompt)
    await act(async () => quickPrompt.click())
    assert.equal((document.querySelector('textarea') as HTMLTextAreaElement).value, '切页后还在')

    await act(async () => {
      (document.querySelector('#go-other-project') as HTMLButtonElement).click()
    })
    await act(async () => { await Promise.resolve() })
    // 模拟从 B 项目的流程页返回 A 项目的原对话。
    const navigateBack = () => {
      window.history.pushState({}, '', '/chat?project=demo&session=session-1')
      window.dispatchEvent(new window.PopStateEvent('popstate'))
    }
    await act(async () => { navigateBack(); await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    assert.equal((document.querySelector('textarea') as HTMLTextAreaElement).value, '切页后还在')
  } finally {
    await act(async () => root.unmount())
    restoreApis()
    await window.happyDOM.close()
  }
})

test('chat draft survives transient activeProject changes without a project URL param', async () => {
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
  useProjectStore.setState({
    projects: [project, otherProject] as never,
    activeProject: project as never,
    activeWorkflowId: null,
    loading: false,
  })
  useChatListStore.setState({ sessionsByProject: {}, quickButtons: [], listLoadingByProject: {} })
  useChatSessionStore.setState({ sessions: {} })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/chat?session=session-1']}>
          <I18nProvider><ChatRouteHarnessWithoutProject /></I18nProvider>
        </MemoryRouter>,
      )
    })
    await act(async () => { await Promise.resolve() })
    const quickPrompt = [...document.querySelectorAll('button')]
      .find((button) => button.textContent === '填入草稿')
    assert.ok(quickPrompt)
    await act(async () => quickPrompt.click())
    assert.equal((document.querySelector('textarea') as HTMLTextAreaElement).value, '切页后还在')

    await act(async () => {
      (document.querySelector('#switch-other-project') as HTMLButtonElement).click()
    })
    await act(async () => { await Promise.resolve() })
    await act(async () => {
      (document.querySelector('#switch-back-project') as HTMLButtonElement).click()
    })
    await act(async () => { await Promise.resolve() })

    assert.equal((document.querySelector('textarea') as HTMLTextAreaElement).value, '切页后还在')
  } finally {
    await act(async () => root.unmount())
    restoreApis()
    await window.happyDOM.close()
  }
})

test('chat draft survives when activeProject is stale after a workflow switch', async () => {
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
  localStorage.setItem('workstep-chat-draft:session-1', '切页后还在')
  useProjectStore.setState({
    projects: [project, otherProject] as never,
    // 模拟刚从 B 项目流程切回 A 项目对话，URL 已是 A，但 store 尚未同步。
    activeProject: otherProject as never,
    activeWorkflowId: 'wf-2',
    loading: false,
  })
  useChatListStore.setState({ sessionsByProject: {}, quickButtons: [], listLoadingByProject: {} })
  useChatSessionStore.setState({ sessions: {} })
  const container = document.body.appendChild(document.createElement('div'))

  try {
    const root = await renderChat(container)
    assert.equal((document.querySelector('textarea') as HTMLTextAreaElement).value, '切页后还在')
    await act(async () => root.unmount())
  } finally {
    restoreApis()
    await window.happyDOM.close()
  }
})

test('restores the persisted session engine over a conflicting local selection', async () => {
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
  // 模拟旧缓存与已保存会话引擎冲突。
  localStorage.setItem(
    'workstep-chat-engine-config:project-1:session-1',
    JSON.stringify({
      engine: 'zz-resumed-engine', providerId: '', model: '',
      fastModel: '', visionModel: '', thinkingEffort: 'high',
    }),
  )
  const restoreApis = installApiStubs()
  useProjectStore.setState({ projects: [project] as never, activeProject: project as never, loading: false })
  useChatListStore.setState({ sessionsByProject: {}, quickButtons: [], listLoadingByProject: {} })
  useChatSessionStore.setState({ sessions: {} })
  const container = document.body.appendChild(document.createElement('div'))

  try {
    const root = await renderChat(container)
    assert.match(document.body.textContent || '', /Claude Code CLI/)
    assert.doesNotMatch(document.body.textContent || '', /zz-resumed-engine/)
    assert.equal(JSON.parse(localStorage.getItem(
      'workstep-chat-engine-config:project-1:session-1',
    ) || '{}').engine, 'claude')
    await act(async () => root.unmount())
  } finally {
    restoreApis()
    await window.happyDOM.close()
  }
})

test('late provider catalog clears an incompatible saved provider without reloading history', async () => {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {
    window, document: window.document, navigator: window.navigator,
    localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    Event: window.Event, InputEvent: window.InputEvent,
    HTMLElement: window.HTMLElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
    requestAnimationFrame: (callback: FrameRequestCallback) => window.setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => window.clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const key = 'workstep-chat-engine-config:project-1:session-1'
  localStorage.setItem(key, JSON.stringify({
    engine: 'claude', providerId: 'prov-1', model: '',
    fastModel: '', visionModel: '', thinkingEffort: '',
  }))
  const restoreApis = installApiStubs()
  let resolveProviders!: (value: Awaited<ReturnType<typeof providerApi.list>>) => void
  const providerResult = new Promise<Awaited<ReturnType<typeof providerApi.list>>>(
    (resolve) => { resolveProviders = resolve },
  )
  providerApi.list = async () => providerResult
  assistantApi.list = async () => ({ assistants: [{
    name: 'chat_session',
    configured: { engine: 'claude', model: '', fast_model: '', vision_model: '', thinking_effort: '' },
    available_engines: [{
      id: 'claude', installed: true, configured: true, verified: true,
      supports_coordinator: true, supports_provider: false, provider_protocols: [],
    }],
  }] }) as never
  let historyRequests = 0
  chatSessionApi.get = async (sessionId: string, projectId: string) => {
    historyRequests += 1
    return {
      id: sessionId, project_id: projectId, workflow_id: null, title: '会话',
      engine: 'claude', provider_id: '', model: '', fast_model: '', vision_model: '',
      permission_mode: '', message_count: 0, messages: [], running: false,
      created_at: '', updated_at: '',
    } as never
  }
  useProjectStore.setState({ projects: [project] as never, activeProject: project as never, loading: false })
  useChatListStore.setState({ sessionsByProject: {}, quickButtons: [], listLoadingByProject: {} })
  useChatSessionStore.setState({ sessions: {} })
  const container = document.body.appendChild(document.createElement('div'))
  let root: Root | undefined
  try {
    root = await renderChat(container)
    assert.equal(JSON.parse(localStorage.getItem(key) || '{}').providerId, 'prov-1')
    await act(async () => {
      resolveProviders({ providers: [{
        id: 'prov-1', name: 'Provider', type: 'custom', protocol: 'openai_responses',
        base_url: '', enabled: true, model_count: 0,
      }] })
      await providerResult
    })
    assert.equal(JSON.parse(localStorage.getItem(key) || '{}').providerId, '')
    assert.equal(historyRequests, 1)
  } finally {
    if (root) await act(async () => root.unmount())
    restoreApis()
    await window.happyDOM.close()
  }
})

test('permission mode remains editable and updates immediately while running', async () => {
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
  const updates: string[] = []
  const restoreApis = installApiStubs(true, (mode) => {
    updates.push(mode)
    if (mode === 'read-only') throw new Error('permission update rejected')
  })
  useProjectStore.setState({ projects: [project] as never, activeProject: project as never, loading: false })
  useChatListStore.setState({ sessionsByProject: {}, quickButtons: [], listLoadingByProject: {} })
  useChatSessionStore.setState({ sessions: {} })
  const container = document.body.appendChild(document.createElement('div'))

  try {
    const root = await renderChat(container)
    const permissionButton = [...document.querySelectorAll('button')]
      .find((button) => button.title === '权限') as HTMLButtonElement | undefined
    assert.ok(permissionButton)
    assert.equal(permissionButton.disabled, false)

    await act(async () => permissionButton.click())
    const workspaceWrite = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('工作区写入')) as HTMLButtonElement | undefined
    assert.ok(workspaceWrite)
    await act(async () => workspaceWrite.click())
    await act(async () => { await Promise.resolve() })

    assert.deepEqual(updates, ['workspace-write'])

    await act(async () => permissionButton.click())
    const readOnly = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('只读')) as HTMLButtonElement | undefined
    assert.ok(readOnly)
    await act(async () => readOnly.click())
    await act(async () => { await Promise.resolve() })

    assert.deepEqual(updates, ['workspace-write', 'read-only'])
    assert.match(permissionButton.textContent || '', /工作区写入/)
    assert.match(document.body.textContent || '', /permission update rejected/)
    await act(async () => root.unmount())
  } finally {
    restoreApis()
    await window.happyDOM.close()
  }
})
