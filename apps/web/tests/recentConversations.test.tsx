import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { I18nProvider } from '../src/i18n'
import RecentConversations from '../src/components/RecentConversations'
import { NavigationDismissContext } from '../src/components/NavigationDismissContext'
import { useRecentVisitsStore } from '../src/stores/recentVisitsStore'
import { useProjectStore } from '../src/stores/projectStore'
import { useRecordRecentVisit } from '../src/hooks/useRecordRecentVisit'
import { taskApi, type Task, type ChatSessionSummary } from '../src/api/client'
import { useChatListStore, useChatSessionStore } from '../src/stores/chatSessionStore'
import type { AssistantSessionState } from '../src/stores/assistantStore'
import { useRecentActivityStore } from '../src/stores/recentActivityStore'
import { useSidebarActivityStore } from '../src/stores/sidebarActivityStore'
import type { RecentVisitTarget } from '../src/stores/recentVisitsStore'

test('recent records are expanded immediately and clicks reopen the original target in its project', async () => {
  const { window } = installDomEnvironment()
  const oldProject = useProjectStore.getState()
  const projects = [
    { id: 'p', name: '项目已重命名', path: '/tmp/demo', steps: {}, workflows: [] },
    { id: 'q', name: '另一个项目', path: '/tmp/other', steps: {}, workflows: [] },
  ]
  useProjectStore.setState({ projects, activeProject: projects[0] })
  const store = useRecentVisitsStore.getState()
  store.visit({ kind: 'session', id: 's1', projectId: 'p', title: '原会话' })
  store.visit({ kind: 'task', id: 't1', projectId: 'q', title: '原任务', workflowId: 'wf' })
  store.visit({ kind: 'session', id: 'hidden', projectId: 'removed', title: '已移除项目' })
  let dismissed = 0
  function Surface() { const location = useLocation(); return <><RecentConversations /><output>{location.pathname + location.search}</output></> }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter><NavigationDismissContext.Provider value={() => { dismissed++ }}><Surface /></NavigationDismissContext.Provider></MemoryRouter></I18nProvider>))
    const rows = () => [...container.querySelectorAll<HTMLButtonElement>('.layout-recent-row')]
    assert.deepEqual(rows().map(x => x.textContent), ['原任务', '原会话'])
    assert.ok(rows()[0].querySelector('svg.lucide-workflow'), 'tasks use the same workflow icon as the project tree')
    assert.ok(rows()[1].querySelector('svg.lucide-bot'), 'conversations keep the existing bot icon')
    assert.equal(container.querySelector('input'), null)
    assert.ok(useRecentActivityStore.getState().targets.every(target => target.projectId !== 'removed'), 'unreadable records are excluded from status subscriptions')
    await act(async () => rows()[1].click())
    let url = new URL(container.querySelector('output')!.textContent!, 'http://localhost')
    assert.equal(url.pathname, '/chat')
    assert.equal(url.searchParams.get('project'), '项目已重命名')
    assert.equal(url.searchParams.get('session'), 's1')
    assert.equal(rows()[0].textContent, '原会话')
    assert.equal(rows()[0].getAttribute('aria-current'), 'page')
    await act(async () => rows()[1].click())
    url = new URL(container.querySelector('output')!.textContent!, 'http://localhost')
    assert.equal(url.pathname, '/tasks')
    assert.equal(url.searchParams.get('task'), 't1')
    assert.equal(url.searchParams.get('workflow'), 'wf')
    assert.equal(useProjectStore.getState().activeProject?.id, 'q')
    assert.equal(dismissed, 2)
  } finally {
    await act(async () => root.unmount())
    useProjectStore.setState(oldProject)
    await window.happyDOM.close()
  }
})

test('opening a task records one visit, live title changes keep ordering, reopening promotes it', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const a: RecentVisitTarget = { kind: 'task', id: 'a', title: '任务 A', projectId: 'p' }
  const b: RecentVisitTarget = { kind: 'task', id: 'b', title: '任务 B', projectId: 'p' }
  function Probe({ target }: { target: RecentVisitTarget | null }) { useRecordRecentVisit(target); return null }
  const render = (target: RecentVisitTarget | null) => act(async () => root.render(<Probe target={target} />))
  try {
    await render(a)
    useRecentVisitsStore.getState().visit(b)
    await render({ ...a, title: '任务 A 新标题' })
    assert.deepEqual(useRecentVisitsStore.getState().entries.map(x => x.id), ['b', 'a'])
    await render(null)
    await render(a)
    assert.deepEqual(useRecentVisitsStore.getState().entries.map(x => x.id), ['a', 'b'])
    assert.equal(useRecentVisitsStore.getState().entries.length, 2)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('recent sessions and cross-project tasks show spinners only while running', async () => {
  const { window } = installDomEnvironment()
  const oldProjects = useProjectStore.getState()
  const oldList = useChatListStore.getState()
  const oldChat = useChatSessionStore.getState()
  const originalGet = taskApi.get
  const originalFetch = useChatListStore.getState().fetchSessions
  const projects = [
    { id: 'p', name: '项目', path: '/tmp/p', steps: {}, workflows: [] },
    { id: 'q', name: '其他项目', path: '/tmp/q', steps: {}, workflows: [] },
  ]
  let status = 'running'
  let reads = 0
  taskApi.get = async () => { reads++; return { id: 't1', status } as Task }
  useProjectStore.setState({ projects, activeProject: projects[0] })
  useChatListStore.setState({ sessionsByProject: { p: [{ id: 's1', running: true } as ChatSessionSummary] }, fetchSessions: async () => {} })
  useChatSessionStore.setState({ sessions: {} })
  useRecentVisitsStore.getState().visit({ kind: 'session', id: 's1', projectId: 'p', title: '会话' })
  useRecentVisitsStore.getState().visit({ kind: 'task', id: 't1', projectId: 'q', title: '任务' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter><RecentConversations /></MemoryRouter></I18nProvider>))
    assert.equal(container.querySelectorAll('.task-status-spinner').length, 2)
    assert.equal(reads, 1)
    await act(async () => useChatSessionStore.setState({ sessions: { s1: { running: false } as AssistantSessionState } }))
    assert.equal(container.querySelectorAll('.task-status-spinner').length, 1, 'live session state overrides cached running state')
    for (const next of ['paused', 'stopped', 'ready']) {
      status = next
      await act(async () => useRecentActivityStore.getState().handleWsEvent({ type: 'CUSTOM', name: 'workstep.status', task_id: 't1', project_id: 'q', value: { status: next } }))
      assert.equal(container.querySelectorAll('.task-status-spinner').length, 0)
    }
    status = 'running'
    await act(async () => window.dispatchEvent(new Event('workstep:reconnected')))
    assert.equal(container.querySelectorAll('.task-status-spinner').length, 1)
    status = 'ready'
    await act(async () => useRecentActivityStore.getState().refreshTasks())
    assert.ok(container.querySelector('.layout-recent-row .sidebar-completion-dot'), 'task outcomes appear in the recent row')
    await act(async () => container.querySelector<HTMLButtonElement>('.layout-recent-row')!.click())
    assert.equal(container.querySelector('.sidebar-completion-dot'), null, 'opening a task acknowledges completion')
    status = 'running'
    await act(async () => useRecentActivityStore.getState().refreshTasks())
    status = 'failed'
    await act(async () => useRecentActivityStore.getState().refreshTasks())
    assert.equal(container.querySelector('.sidebar-failure-dot'), null, 'an open task is already read')
  } finally {
    await act(async () => root.unmount())
    taskApi.get = originalGet
    useChatListStore.setState({ ...oldList, fetchSessions: originalFetch })
    useChatSessionStore.setState(oldChat)
    useProjectStore.setState(oldProjects)
    await window.happyDOM.close()
  }
})


test('recent sessions share completion and failure dots and acknowledge them on open', async () => {
  const { window } = installDomEnvironment()
  const oldProjects = useProjectStore.getState()
  const oldList = useChatListStore.getState()
  const oldChat = useChatSessionStore.getState()
  const oldActivity = useSidebarActivityStore.getState()
  const project = { id: 'p', name: '项目', path: '/tmp/p', steps: {}, workflows: [] }
  useProjectStore.setState({ projects: [project], activeProject: project })
  useRecentVisitsStore.setState({ entries: [] })
  useRecentVisitsStore.getState().visit({ kind: 'session', id: 's1', projectId: 'p', title: '会话' })
  useChatListStore.setState({ sessionsByProject: { p: [{ id: 's1', last_message_status: 'error' } as ChatSessionSummary] } })
  useChatSessionStore.setState({ sessions: {} })
  useSidebarActivityStore.setState({ completedSessions: { s1: true }, readFailedSessions: {} })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter><RecentConversations /></MemoryRouter></I18nProvider>))
    assert.ok(container.querySelector('.sidebar-failure-dot'), 'failure wins over completion')
    await act(async () => useChatSessionStore.setState({ sessions: { s1: { running: true, messages: [{ status: 'error' }] } as AssistantSessionState } }))
    assert.ok(container.querySelector('.task-status-spinner'))
    assert.equal(container.querySelector('.sidebar-failure-dot'), null)
    await act(async () => useChatSessionStore.setState({ sessions: { s1: { running: false, messages: [{ status: 'done' }] } as AssistantSessionState } }))
    assert.ok(container.querySelector('.sidebar-completion-dot'), 'live success overrides cached failure')
    await act(async () => container.querySelector<HTMLButtonElement>('.layout-recent-row')!.click())
    assert.equal(container.querySelector('.sidebar-completion-dot'), null)
    assert.equal(useSidebarActivityStore.getState().readFailedSessions.s1, true)
  } finally {
    await act(async () => root.unmount())
    useProjectStore.setState(oldProjects)
    useChatListStore.setState(oldList)
    useChatSessionStore.setState(oldChat)
    useSidebarActivityStore.setState(oldActivity)
    await window.happyDOM.close()
  }
})
