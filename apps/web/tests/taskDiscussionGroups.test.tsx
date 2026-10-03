import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import TaskDiscussionGroups from '../src/components/TaskDiscussionGroups'

test('task discussion panel binds a received group ID to the current task', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const previousFetch = globalThis.fetch
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  let groups: unknown[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method || 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const data = url === '/api/channel-bots'
      ? [{ id: 'bot-1', name: '企业微信', platform: 'wecom', enabled: true }]
      : url.endsWith('/recent-groups')
        ? [{ bot_id: 'bot-1', group_id: 'group-1' }]
        : method === 'POST'
          ? (groups = [{ bot_id: 'bot-1', group_id: 'group-1', project_id: 'project-1', task_id: 'task-1' }], groups[0])
          : groups
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><TaskDiscussionGroups open projectId="project-1" taskId="task-1" onClose={() => {}} /></I18nProvider>))
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] .task-discussion-groups input')!
    const select = document.querySelector<HTMLSelectElement>('[role="dialog"] select[aria-label="最近收到的群"]')!
    assert.ok(select, 'received groups must have an explicit selector')
    const bind = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === '绑定群')!
    assert.equal(bind.disabled, true)
    await act(async () => {
      select.value = 'group-1'
      select.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
    assert.equal(input.value, 'group-1')
    assert.equal(bind.disabled, false)
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'manual-group')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(select.value, '')
    await act(async () => {
      select.value = 'group-1'
      select.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
    await act(async () => bind.click())
    assert.deepEqual(calls.find((call) => call.method === 'POST')?.body, {
      project_id: 'project-1', bot_id: 'bot-1', group_id: 'group-1',
    })
    assert.match(document.querySelector('.task-discussion-groups-list')?.textContent || '', /group-1/)
    assert.equal(input.value, '')
    assert.equal(select.value, '')
    assert.equal(bind.disabled, true)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = previousFetch
    await window.happyDOM.close()
  }
})
