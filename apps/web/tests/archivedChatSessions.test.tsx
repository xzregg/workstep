import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ArchivedChatSessions from '../src/components/ArchivedChatSessions'
import { chatSessionApi, type ChatSessionSummary } from '../src/api/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { useChatListStore } from '../src/stores/chatSessionStore'

const row = (id: string, title: string): ChatSessionSummary => ({
  id, title, project_id: 'p1', workflow_id: '', engine: 'codex', message_count: 1,
  archived: true,
})

test('archived conversations can be searched, selected and restored', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useChatListStore.setState({ sessionsByProject: {} })
  const originalList = chatSessionApi.list
  const originalArchive = chatSessionApi.setArchived
  const originalBulkDelete = chatSessionApi.bulkDelete
  const calls: string[] = []
  const deleted: string[] = []
  chatSessionApi.list = async (_projectId, archived) => {
    assert.equal(archived, true)
    return { sessions: [{ ...row('one', '设计讨论'), source: 'channel' }, row('two', '接口讨论')] }
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
    await act(async () => confirm.click())
    assert.deepEqual(deleted, ['two'])
    assert.doesNotMatch(container.textContent || '', /接口讨论/)
  } finally {
    chatSessionApi.list = originalList
    chatSessionApi.setArchived = originalArchive
    chatSessionApi.bulkDelete = originalBulkDelete
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
