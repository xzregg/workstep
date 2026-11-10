import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import SidebarSessionGroups, { SessionGroupCreationArea } from '../src/components/SidebarSessionGroups'
import { chatGroupApi } from '../src/api/chatGroups'
import { useChatListStore } from '../src/stores/chatSessionStore'
import { useChatWorkspaceStore } from '../src/stores/chatWorkspaceStore'
import { writeChatSessionDrag } from '../src/utils/chatSessionDrag'

test('groups collapse, accept same-project drops, and require confirmation for bulk removal', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const original = { ...chatGroupApi }
  let groups = [{ id: 'g1', name: '研发', source: 'chat' as const, session_ids: ['s1'] }]
  const calls: unknown[] = []
  chatGroupApi.list = async () => ({ groups })
  chatGroupApi.mutate = async (_pid, request) => { calls.push(request); return { groups, removed: [], skipped: [] } }
  try {
    await act(async () => root.render(<I18nProvider><SidebarSessionGroups projectId="p1" source="chat" canManage
      sessions={[{ id: 's1', title: '会话一' }, { id: 's2', title: '会话二' }] as never}
      renderSession={session => <div key={session.id}>{session.title}</div>} /></I18nProvider>))
    const toggle = container.querySelector<HTMLButtonElement>('[aria-expanded]')!
    assert.ok(toggle)
    assert.equal(container.textContent?.includes('未分组'), false, 'ungrouped conversations have no visible heading')
    await act(async () => toggle.click())
    assert.equal(container.textContent?.includes('会话一'), false)
    await act(async () => toggle.click())
    assert.equal(container.textContent?.includes('会话一'), true)
    const header = container.querySelector('[data-session-group="g1"] .sidebar-session-group-header')!
    for (const pid of ['foreign', 'p1']) {
      const dataTransfer = new window.DataTransfer()
      writeChatSessionDrag(dataTransfer as unknown as DataTransfer, pid, 's2')
      const event = new window.Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      await act(async () => header.dispatchEvent(event))
    }
    assert.deepEqual(calls, [{ action: 'move', group_id: 'g1', session_id: 's2' }])
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="分组操作"]')!.click())
    assert.equal([...document.querySelectorAll('.sidebar-action-item')].some(item => item.textContent === '创建分组'), false)
    const remove = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '删除分组')!
    await act(async () => remove.click())
    assert.equal(calls.length, 1)
    assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes('1'))
    const confirm = document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!
    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    assert.ok(checkbox)
    assert.equal(checkbox.checked, false)
    await act(async () => confirm.click())
    assert.deepEqual(calls[1], { action: 'dissolve', group_id: 'g1', delete_sessions: false })
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="分组操作"]')!.click())
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '删除分组')!.click())
    const deleteCheckbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await act(async () => deleteCheckbox.click())
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /无法撤销/)
    await act(async () => document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click())
    assert.deepEqual(calls[2], { action: 'delete', group_id: 'g1', delete_sessions: true })

  } finally {
    Object.assign(chatGroupApi, original)
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})


test('heading context menu creates a named group, validates blank input, and retains errors for retry', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const original = { ...chatGroupApi }
  chatGroupApi.list = async () => ({ groups: [] })
  let calls = 0, fail = true
  chatGroupApi.mutate = async (_pid, request) => {
    calls++
    if (fail) throw new Error('保存失败')
    assert.equal(request.name, '研发')
    return { groups: [{ id: 'new', name: '研发', source: 'chat', session_ids: [] }], removed: [], skipped: [] }
  }
  try {
    await act(async () => root.render(<I18nProvider><SessionGroupCreationArea canManage onOpen={() => {}}>
      <div data-heading>对话</div>
      <SidebarSessionGroups projectId="create-test" source="chat" canManage sessions={[]} renderSession={() => null} />
    </SessionGroupCreationArea></I18nProvider>))
    await act(async () => container.querySelector('[data-heading]')!.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
    const menuItem = [...document.querySelectorAll<HTMLButtonElement>('.floating-menu button')].find(button => button.textContent?.includes('创建分组'))
      || [...document.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent === '创建分组').at(-1)!
    assert.ok(menuItem.querySelector('svg'), 'create group has a folder icon')
    assert.ok(menuItem.closest('.sidebar-action-menu'), 'uses compact sidebar menu styling')
    await act(async () => menuItem.click())
    const confirm = document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!
    assert.equal(confirm.disabled, true)
    const input = document.querySelector<HTMLInputElement>('[aria-label="分组名"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '研发')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(confirm.disabled, false)
    await act(async () => confirm.click())
    assert.equal(calls, 1)
    assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes('保存失败'))
    fail = false
    await act(async () => confirm.click())
    assert.equal(calls, 2)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.ok(container.querySelector('[data-session-group="new"]'))
  } finally {
    Object.assign(chatGroupApi, original)
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})


test('group archive confirms before acting and cleans up only successful members', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...chatGroupApi }
  const oldList = useChatListStore.getState()
  const oldWorkspace = useChatWorkspaceStore.getState()
  const sessions = [{ id: 'done', title: '已完成' }, { id: 'running', title: '进行中' }] as never
  useChatListStore.setState({ sessionsByProject: { archive: sessions } })
  const removed: string[][] = []
  useChatWorkspaceStore.setState({ removeSessions: async (_pid, ids) => { removed.push(ids); return false } })
  chatGroupApi.list = async () => ({ groups: [{ id: 'group', name: '归档测试', source: 'chat', session_ids: ['done', 'running'] }] })
  let called = false
  chatGroupApi.mutate = async (_pid, req) => {
    assert.equal(req.action, 'archive'); called = true
    return { groups: [{ id: 'group', name: '归档测试', source: 'chat', session_ids: ['running'] }], removed: ['done'], skipped: ['running'] }
  }
  try {
    await act(async () => root.render(<I18nProvider><SidebarSessionGroups projectId="archive" source="chat" canManage sessions={sessions} renderSession={s => <div key={s.id}>{s.title}</div>} /></I18nProvider>))
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="分组操作"]')!.click())
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '归档分组')!.click())
    assert.equal(called, false)
    assert.match(document.querySelector('[role="dialog"]')!.textContent!, /2 个对话/)
    await act(async () => document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click())
    assert.equal(called, true)
    assert.deepEqual(removed, [['done']])
    assert.deepEqual(useChatListStore.getState().sessionsByProject.archive.map(s => s.id), ['running'])
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /1 个对话未能处理/)
    assert.ok(document.querySelector('[data-session-group="group"]'))
  } finally {
    Object.assign(chatGroupApi, original)
    useChatListStore.setState(oldList)
    useChatWorkspaceStore.setState(oldWorkspace)
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('group menu creates once in its own group without a standalone plus and expands after success', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = chatGroupApi.list
  chatGroupApi.list = async () => ({ groups: [{ id: 'target', name: '目标组', source: 'chat', session_ids: [] }] })
  let finish!: (id: string) => void
  const calls: string[] = []
  try {
    await act(async () => root.render(<I18nProvider><SidebarSessionGroups projectId="plus-test" source="chat" canManage sessions={[]}
      renderSession={() => null} onCreateSession={groupId => { calls.push(groupId); return new Promise(resolve => { finish = resolve }) }} /></I18nProvider>))
    await act(async () => document.querySelector<HTMLButtonElement>('.sidebar-session-group-toggle')!.click())
    assert.equal(document.querySelector('.sidebar-session-group-header .sidebar-add-button') === null, true)
    await act(async () => document.querySelector<HTMLButtonElement>('.sidebar-session-group-more')!.click())
    const add = document.querySelector<SVGElement>('.sidebar-action-menu .lucide-plus')!.closest('button')!
    await act(async () => { add.click(); add.click() })
    assert.deepEqual(calls, ['target'])
    assert.equal(document.querySelector('.sidebar-action-menu'), null)
    await act(async () => finish('new-session'))
    assert.equal(document.querySelector('.sidebar-session-group-toggle')!.getAttribute('aria-expanded'), 'true')
    await act(async () => document.querySelector('.sidebar-session-group-header')!.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
    const contextAdd = document.querySelector<SVGElement>('.sidebar-action-menu .lucide-plus')!.closest('button')!
    await act(async () => contextAdd.click())
    assert.deepEqual(calls, ['target', 'target'])
    await act(async () => finish('second-session'))
  } finally {
    chatGroupApi.list = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('group running indicator survives collapse and group drag persists order without a session payload', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width: 1600, height: 1000 })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...chatGroupApi }
  const groups = [{id:'first',name:'第一组',source:'chat' as const,session_ids:['running']},{id:'second',name:'第二组',source:'chat' as const,session_ids:[]}]
  chatGroupApi.list = async () => ({groups})
  const calls: unknown[] = []
  chatGroupApi.mutate = async (_pid, request) => { calls.push(request); return {groups:[groups[1],groups[0]],removed:[],skipped:[]} }
  const render = (running: boolean) => <I18nProvider><SidebarSessionGroups projectId="reorder" source="chat" canManage sessions={[]}
    runningSessions={running ? { running: true } : {}} renderSession={() => null} /></I18nProvider>
  const drag = (target: Element, type: string, transfer: DataTransfer) => {
    const event = new window.Event(type, { bubbles:true, cancelable:true })
    Object.defineProperty(event,'dataTransfer',{value:transfer})
    Object.defineProperty(event,'clientY',{value:-1})
    target.dispatchEvent(event)
  }
  try {
    await act(async () => root.render(render(true)))
    assert.ok(document.querySelector('[data-session-group="first"] .task-status-spinner'))
    await act(async () => document.querySelector<HTMLButtonElement>('[data-session-group="first"] .sidebar-session-group-toggle')!.click())
    assert.ok(document.querySelector('[data-session-group="first"] .task-status-spinner'))
    const transfer = new window.DataTransfer() as unknown as DataTransfer
    const first = document.querySelector('[data-session-group="first"] .sidebar-session-group-header')!
    const second = document.querySelector('[data-session-group="second"] .sidebar-session-group-header')!
    assert.equal(second.getAttribute('draggable'), 'true')
    await act(async () => drag(second,'dragstart',transfer))
    assert.equal(transfer.getData('application/x-workstep-chat-session'), '')
    await act(async () => drag(first,'dragover',transfer))
    await act(async () => drag(first,'drop',transfer))
    assert.deepEqual(calls,[{action:'reorder',group_id:'second',target_group_id:'first',before:true}])
    assert.equal(document.querySelector('[data-session-group]')!.getAttribute('data-session-group'),'second')
    await act(async () => root.render(render(false)))
    assert.equal(document.querySelector('.task-status-spinner'),null)
  } finally {
    Object.assign(chatGroupApi,original)
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
