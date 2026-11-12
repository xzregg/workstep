import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ArchivedChatSessions from '../src/components/ArchivedChatSessions'
import { chatSessionApi, type ChatSessionSummary } from '../src/api/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { useChatListStore } from '../src/stores/chatSessionStore'
import { useRecentVisitsStore } from '../src/stores/recentVisitsStore'

const row = (id: string, title: string): ChatSessionSummary => ({
  id, title, project_id: 'p1', workflow_id: '', engine: 'codex', message_count: 1,
  archived: true,
})

test('archived conversations can be searched, selected and restored', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useChatListStore.setState({ sessionsByProject: {} })
  const originalList = chatSessionApi.list
  const originalGet = chatSessionApi.get
  const previewCalls: string[] = []
  chatSessionApi.get = async (id) => {
    previewCalls.push(id)
    return { ...row(id, id), messages: [
      { id: "old", role: "user", content: "旧问题不显示", status: "succeeded" },
      { id: "q", role: "user", content: "最后一个问题", status: "succeeded" },
      { id: "a", role: "assistant", content: "最后一个回复", status: "succeeded" },
    ] }
  }
  const originalArchive = chatSessionApi.setArchived
  const originalBulkDelete = chatSessionApi.bulkDelete
  const calls: string[] = []
  const deleted: string[] = []
  chatSessionApi.list = async (_projectId, archived) => {
    assert.equal(archived, true)
    return { sessions: [{ ...row('one', '设计讨论'), archived_at: '2026-01-02T03:04:05Z', source: 'channel' }, row('two', '接口讨论')] }
  }
  chatSessionApi.setArchived = async (id, _projectId, archived) => {
    assert.equal(archived, false)
    calls.push(id)
    return { ...row(id, id === 'one' ? '设计讨论' : '接口讨论'), archived: false }
  }
  chatSessionApi.bulkDelete = async (_projectId, ids) => {
    deleted.push(...ids)
    return { deleted: ids, skipped: [] }
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ArchivedChatSessions projectId="p1" /></I18nProvider>))
    assert.equal(container.querySelectorAll('.chat-session-source-badge').length, 1)
    const times = container.querySelectorAll('.archived-session-time')
    assert.equal(times.length, 2)
    assert.doesNotMatch(times[0].textContent || '', /归档时间/)
    assert.ok(times[0].closest('.archived-session-row'))
    assert.equal(times[0].querySelector('time')?.dateTime, '2026-01-02T03:04:05Z')
    assert.match(times[1].textContent || '', /—/)
    assert.deepEqual(previewCalls, [])
    const preview = container.querySelector<HTMLButtonElement>('.archived-session-open')!
    await act(async () => preview.click())
    assert.deepEqual(previewCalls, ['one'])
    assert.match(container.textContent || '', /最后一个问题/)
    assert.match(container.textContent || '', /最后一个回复/)
    assert.doesNotMatch(container.textContent || '', /旧问题不显示/)
    await act(async () => preview.click())
    assert.doesNotMatch(container.textContent || '', /最后一个问题/)
    const search = container.querySelector<HTMLInputElement>('input[placeholder="搜索已归档对话"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, '设计')
      search.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.match(container.textContent || '', /设计讨论/)
    assert.doesNotMatch(container.textContent || '', /接口讨论/)
    const restore = [...container.querySelectorAll('button')].find((button) => button.textContent === '恢复')!
    await act(async () => restore.click())
    assert.deepEqual(calls, ['one'])
    assert.equal(useChatListStore.getState().sessionsByProject.p1[0].id, 'one')
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, '')
      search.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    const selectAll = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await act(async () => selectAll.click())
    const deleteSelected = [...container.querySelectorAll('button')].find((button) => button.textContent === '批量删除')!
    await act(async () => deleteSelected.click())
    const confirm = [...document.querySelectorAll('button')].find((button) => button.textContent === '确认删除')!
    useRecentVisitsStore.getState().visit({ kind: 'session', id: 'two', projectId: 'p1', title: '接口讨论' })
    await act(async () => confirm.click())
    assert.deepEqual(deleted, ['two'])
    useRecentVisitsStore.getState().hydrate()
    assert.equal(useRecentVisitsStore.getState().entries.some(entry => entry.id === 'two'), false)
    assert.doesNotMatch(container.textContent || '', /接口讨论/)
  } finally {
    chatSessionApi.get = originalGet
    chatSessionApi.list = originalList
    chatSessionApi.setArchived = originalArchive
    chatSessionApi.bulkDelete = originalBulkDelete
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
