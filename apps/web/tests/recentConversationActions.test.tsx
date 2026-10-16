import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { chatSessionApi } from '../src/api/client'
import RecentConversations from '../src/components/RecentConversations'
import { useRecentVisitsStore } from '../src/stores/recentVisitsStore'
import { useProjectStore } from '../src/stores/projectStore'
import { useChatListStore } from '../src/stores/chatSessionStore'
import { useTaskStore } from '../src/stores/taskStore'

test('recent task time reveals archive and reuses the task archive dialog', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const oldProjects = useProjectStore.getState(), oldTasks = useTaskStore.getState()
  const project = { id: 'p', name: '演示', path: '/tmp/demo', workflows: [], steps: {} }
  useProjectStore.setState({ projects: [project], activeProject: project })
  useRecentVisitsStore.getState().visit({ kind: 'task', id: 'task', projectId: 'p', title: '任务' })
  let calls = 0, fail = true
  useTaskStore.setState({
    getArchiveExperienceDraft: async () => ({ found: false } as never),
    archiveTask: async (id, projectId) => {
      assert.equal(id, 'task'); assert.equal(projectId, 'p'); calls++
      if (fail) throw new Error('归档失败')
    },
  })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter><RecentConversations /></MemoryRouter></I18nProvider>))
    const time = container.querySelector<HTMLButtonElement>('.ws-session-time-button')
    assert.ok(time, 'task timestamps support the same reveal action as conversations')
    await act(async () => time.click())
    assert.equal(calls, 0)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="归档任务"]')!.click())
    const directArchive = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '直接归档')!
    assert.ok(directArchive(), 'reuse the existing archive experience dialog')
    await act(async () => directArchive().click())
    assert.ok(document.querySelector('[role="alert"]'))
    assert.equal(useRecentVisitsStore.getState().entries.length, 1, 'failures retain the recent record')
    fail = false
    await act(async () => directArchive().click())
    assert.equal(calls, 2)
    assert.equal(useRecentVisitsStore.getState().entries.length, 0)
  } finally {
    await act(async () => root.unmount())
    useProjectStore.setState(oldProjects); useTaskStore.setState(oldTasks)
    await window.happyDOM.close()
  }
})

for (const action of ['archive', 'rename', 'delete'] as const) test(`recent conversation ${action} reuses the original controls without navigating`, async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const originalProject = useProjectStore.getState(), originalList = useChatListStore.getState()
  const originalApi = { rename: chatSessionApi.rename, setArchived: chatSessionApi.setArchived, remove: chatSessionApi.remove }
  const project = { id: 'p', name: '演示', path: '/tmp/demo', workflows: [], steps: {} }
  useProjectStore.setState({ projects: [project], activeProject: project })
  useChatListStore.setState({ sessionsByProject: {} })
  const recent = useRecentVisitsStore.getState()
  recent.visit({ kind: 'session', id: 'one', projectId: 'p', title: '原对话' })
  const visitedAt = useRecentVisitsStore.getState().entries[0].visitedAt
  let calls = 0, fail = false
  const called = (id: string, projectId: string) => { assert.equal(id, 'one'); assert.equal(projectId, 'p'); calls++; if (fail) throw new Error('操作失败') }
  chatSessionApi.setArchived = async (id, projectId, archived) => { called(id, projectId); assert.equal(archived, true); return {} as never }
  chatSessionApi.remove = async (id, projectId) => { called(id, projectId); return {} as never }
  chatSessionApi.rename = async (id, projectId, title) => { called(id, projectId); return { title } as never }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label)!
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter><RecentConversations now={Date.now()} /></MemoryRouter></I18nProvider>))
    assert.ok(container.querySelector('time'), 'recent row displays a timestamp immediately')
    const more = container.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!
    assert.ok(more, 'more menu is available on touch without hover')
    await act(async () => more.click())
    assert.equal(useRecentVisitsStore.getState().entries[0].visitedAt, visitedAt, 'opening controls must not count as visiting the conversation')
    assert.ok(button('归档对话'))
    assert.ok(button('重命名'))
    assert.ok(button('删除'))
    await act(async () => button(action === 'archive' ? '归档对话' : action === 'rename' ? '重命名' : '删除').click())
    if (action === 'rename') {
      const input = document.querySelector<HTMLInputElement>('.chat-session-rename-input')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, '新标题')
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
      await act(async () => button('保存').click())
      assert.equal(useRecentVisitsStore.getState().entries[0].title, '新标题')
      assert.equal(useRecentVisitsStore.getState().entries[0].visitedAt, visitedAt)
    } else if (action === 'delete') {
      assert.equal(calls, 0, 'deleting requires the existing confirmation dialog')
      fail = true
      await act(async () => button('确认删除').click())
      assert.ok(document.querySelector('[role="alert"]'))
      assert.equal(useRecentVisitsStore.getState().entries.length, 1)
      fail = false
      await act(async () => button('确认删除').click())
      assert.equal(useRecentVisitsStore.getState().entries.length, 0)
    } else {
      assert.equal(useRecentVisitsStore.getState().entries.length, 0)
    }
    assert.ok(calls > 0)
  } finally {
    await act(async () => root.unmount())
    Object.assign(chatSessionApi, originalApi)
    useProjectStore.setState(originalProject); useChatListStore.setState(originalList)
    await window.happyDOM.close()
  }
})
