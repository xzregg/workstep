import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import TaskDiscussionGroups from '../src/components/TaskDiscussionGroups'

test('task header shows the bound BOT label for an existing group', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify([
    { bot_id: 'bot-1', group_id: 'group-1', project_id: 'project-1', task_id: 'task-1' },
  ]), { status: 200 })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><TaskDiscussionGroups projectId="project-1" taskId="task-1" /></I18nProvider>))
    assert.equal(container.querySelector('.task-detail-discussion-button')?.textContent, '已绑定 BOT')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = previousFetch
    await window.happyDOM.close()
  }
})

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
        ? [{ bot_id: 'bot-1', group_id: 'group-1', group_name: '研发群' }]
        : method === 'POST'
          ? (groups = [{ bot_id: 'bot-1', group_id: 'group-1', project_id: 'project-1', task_id: 'task-1' }], groups[0])
          : method === 'DELETE' ? (groups = [], { deleted: true }) : groups
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><TaskDiscussionGroups projectId="project-1" taskId="task-1" /></I18nProvider>))
    const trigger = container.querySelector<HTMLButtonElement>('.task-detail-discussion-button')!
    assert.equal(trigger.textContent, '绑定BOT')
    await act(async () => trigger.click())
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
    assert.match(select.textContent || '', /研发群/)
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
      project_id: 'project-1', bot_id: 'bot-1', group_id: 'group-1', group_name: '研发群',
    })
    assert.match(document.querySelector('.task-discussion-groups-list')?.textContent || '', /group-1/)
    assert.equal(input.value, '')
    assert.equal(select.value, '')
    assert.equal(bind.disabled, true)
    assert.equal(trigger.textContent, '已绑定 BOT')
    const unbind = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === '解绑')!
    await act(async () => unbind.click())
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === '确认')!
    await act(async () => confirm.click())
    assert.equal(trigger.textContent, '绑定BOT')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = previousFetch
    await window.happyDOM.close()
  }
})

test('groups already bound to another task are disabled and cannot be submitted manually', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const previousFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push(`${init?.method || 'GET'} ${url}`)
    const data = url === '/api/channel-bots'
      ? [{ id: 'bot-1', name: '企业微信', platform: 'wecom', enabled: true,
          task_bindings: [{ bot_id: 'bot-1', group_id: 'used', group_name: '已占用群', project_id: 'other-project', task_id: 'other-task', project_name: '其他项目', task_title: '其他任务' }] }]
      : url.endsWith('/recent-groups')
        ? [{ bot_id: 'bot-1', group_id: 'used', group_name: '已占用群' }, { bot_id: 'bot-1', group_id: 'free', group_name: '空闲群' }]
        : []
    return new Response(JSON.stringify(data), { status: 200 })
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><TaskDiscussionGroups projectId="project-1" taskId="task-1" /></I18nProvider>))
    await act(async () => container.querySelector<HTMLButtonElement>('.task-detail-discussion-button')!.click())
    const select = document.querySelector<HTMLSelectElement>('[role="dialog"] select[aria-label="最近收到的群"]')!
    const used = select.querySelector<HTMLOptionElement>('option[value="used"]')!
    assert.equal(used.disabled, true)
    assert.match(used.textContent!, /其他项目.*其他任务/)
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] .task-discussion-groups input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'used')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    const bind = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === '绑定群')!
    assert.equal(bind.disabled, true)
    assert.match(document.querySelector('.task-discussion-groups')!.textContent!, /其他项目.*其他任务/)
    assert.equal(calls.some((call) => call.startsWith('POST ')), false)
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'free')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(bind.disabled, false)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = previousFetch
    await window.happyDOM.close()
  }
})
