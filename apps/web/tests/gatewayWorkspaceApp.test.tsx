import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../src/App'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'
import { useProjectStore } from '../src/stores/projectStore'
import { useTaskStore } from '../src/stores/taskStore'
import { defaultSkin } from '../src/skins/contract'
import { saveSkin, restoreDefaultSkin } from '../src/skins/runtime'

for (const customSkin of [false, true]) for (const creator of [false, true]) test(`${customSkin ? 'custom skin' : 'default skin'}: ${creator ? 'task creator sees submission but no workflow, Git, file-write or project-chat entries' : 'the real WorkStep app opens the bound task workspace and subscribes within that project'}`, async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('http://d-device-1.localhost:8700/')
  restoreDefaultSkin()
  if (customSkin) saveSkin({ ...defaultSkin(), manifest: { ...defaultSkin().manifest, id: 'permissions-test' }, revision: 'test', tokens: { bg: '#102030' }, layout: { sidebarSide: 'right', engineAppearance: 'cards' } })
  useLocaleStore.setState({ locale: 'zh-CN' })
  const oldFetch = globalThis.fetch
  const oldSocket = globalThis.WebSocket
  const calls: string[] = []
  const creates: Record<string, unknown>[] = []
  const taskState = useTaskStore.getState()
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
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    calls.push(path)
    if (path.startsWith('/api/task/create?project_id=host-1')) {
      assert.equal(init?.method, 'POST')
      const body = JSON.parse(String(init?.body))
      creates.push(body)
      return Response.json({ id: 'created-task', title: body.title, status: 'ready', steps: [],
        created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z', description: '' })
    }
    if (path === '/api/remote/session') return Response.json({
      device_id: 'device-1', device_name: 'PC', username: 'Alice', gateway_url: 'http://localhost:8700/devices',
      project_id: 'platform-1', host_project_id: 'host-1', access_level: creator ? 'edit' : 'read', task_create: creator,
      permissions: creator ? ['task.read', 'workflow.read', 'task.create'] : undefined,
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
    assert.equal(document.documentElement.dataset.skinId, customSkin ? 'permissions-test' : 'default')
    assert.equal(window.location.pathname, '/tasks')
    assert.equal(new URLSearchParams(window.location.search).get('project'), 'Visible')
    assert.equal(new URLSearchParams(window.location.search).get('workflow'), 'flow-1')
    assert.equal(useProjectStore.getState().activeProject?.id, 'host-1')
    assert.equal(calls.includes('/api/project/list'), false)
    assert.equal(calls.filter(path => path === '/api/project/host-1/summary').length, 1)
    assert.ok(subscriptions.some(subscription => subscription.project_id === 'host-1'))
    assert.equal(element.querySelector('.mobile-task-new-button'), null)
    if (!creator) assert.equal(element.querySelector('.task-board-lane-add'), null)
    assert.equal([...element.querySelectorAll('button')].some(button => button.textContent?.trim() === '新建任务'), false)
    if (creator) {
      const buttons = [...element.querySelectorAll('button')]
      for (const label of ['步骤编辑', '新建对话', '添加流程', '流程钩子', 'Git', '设置']) {
        assert.equal(buttons.some(button => button.textContent?.trim() === label), false, label)
      }
      assert.equal(element.querySelector('.layout-sidebar-session-label'), null)
      const create = buttons.find(button => button.textContent?.trim() === '新建')
      assert.ok(create)
      await act(async () => create.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
      assert.ok(element.querySelector('.task-create-panel'))
      assert.equal(element.querySelector('.task-create-ai-button'), null)
      assert.equal(element.querySelector('.task-create-review'), null)
      assert.equal(element.querySelector('input[value="immediate"]'), null)
      assert.equal(element.querySelector('input[value="scheduled"]'), null)
      assert.equal(element.querySelector('.markdown-editor-action[aria-label="上传附件"]'), null)
      const title = element.querySelector<HTMLInputElement>('#new-task-title')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(title, '权限验证任务')
        title.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
      const submit = element.querySelector<HTMLButtonElement>('.task-create-primary')!
      assert.equal(submit.disabled, false)
      await act(async () => submit.click())
      assert.equal(creates.length, 1)
      assert.equal(creates[0].title, '权限验证任务')
      assert.equal(creates[0].auto_start, false)
      assert.equal(creates[0].scheduled_start_at, null)
      assert.equal(creates[0].review_overrides, null)
      assert.equal(element.querySelector('.task-create-panel'), null)
      assert.ok(useTaskStore.getState().tasks.some(task => task.id === 'created-task'))
      // Manually entered URLs cannot mount denied features or request their data.
      for (const path of ['/chat?project=Visible', '/git?project_id=host-1', '/schedules?project=Visible',
        '/statistics?project=Visible', '/file-preview?project_id=host-1&path=README.md']) {
        const requestCount = calls.length
        await act(async () => {
          window.history.pushState({}, '', path)
          window.dispatchEvent(new window.PopStateEvent('popstate'))
        })
        assert.ok(element.querySelector('.project-permission-unavailable'), path)
        assert.equal(element.querySelector('.assistant-chat-panel'), null)
        assert.equal(calls.length, requestCount, `unavailable route must not load data: ${path}`)
      }
    }

  } finally {
    await act(async () => root.unmount())
    element.remove()
    globalThis.fetch = oldFetch
    globalThis.WebSocket = oldSocket
    useGatewaySessionStore.setState({ session: null, error: '', loading: false })
    useProjectStore.setState({ projects: [], activeProject: null, activeWorkflowId: null })
    useTaskStore.setState(taskState)
    restoreDefaultSkin()
    await window.happyDOM.close()
  }
})


test('local startup enters the fixed default workspace chat without creating workflows', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('http://localhost:8878/')
  const oldFetch = globalThis.fetch, oldSocket = globalThis.WebSocket
  const calls: string[] = []
  class Socket {
    static OPEN = 1
    static CONNECTING = 0
    readyState = 1
    close() { this.readyState = 3 }
    send() {}
  }
  Object.assign(globalThis, { WebSocket: Socket, ResizeObserver: window.ResizeObserver })
  globalThis.fetch = async input => {
    const path = String(input); calls.push(path)
    if (path === '/api/project/list') return Response.json({ projects: [{ id: 'runtime', name: 'Runtime', path: '/tmp/runtime', is_default_workspace: true, workflows: [], steps: {} }] })
    if (path.includes('/chat-sessions/quick-buttons')) return Response.json({ buttons: [] })
    if (path.includes('/chat-sessions')) return Response.json({ sessions: [] })
    if (path.includes('/assistant/list')) return Response.json({ assistants: [] })
    return Response.json({ tasks: [], providers: [], engines: [], buttons: [], runs: [] })
  }
  useGatewaySessionStore.setState({ session: null, loading: false })
  useProjectStore.setState({ projects: [], activeProject: null, activeWorkflowId: null })
  const element = document.body.appendChild(document.createElement('div'))
  const root = createRoot(element)
  try {
    await act(async () => root.render(<I18nProvider><App /></I18nProvider>))
    assert.equal(window.location.pathname, '/chat')
    assert.equal(new URLSearchParams(window.location.search).get('project'), 'Runtime')
    assert.equal(useProjectStore.getState().activeWorkflowId, null)
    assert.equal(useProjectStore.getState().activeProject?.workflows.length, 0)
  } finally {
    await act(async () => root.unmount()); element.remove()
    globalThis.fetch = oldFetch; globalThis.WebSocket = oldSocket
    useProjectStore.setState({ projects: [], activeProject: null, activeWorkflowId: null })
    await window.happyDOM.close()
  }
})
