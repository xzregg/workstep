import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { taskApi, assistantApi, providerApi, taskDraftApi, type Project } from '../src/api/client'
import { utcToLocalDateTime } from '../src/utils/scheduledStart'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { useTaskDraftStore } from '../src/stores/taskDraftStore'
import { useTaskStore } from '../src/stores/taskStore'
import TaskCreatePanel from '../src/components/TaskCreatePanel'

test('task creation uses the selected step and blocks empty titles', async () => {
  const { window } = installDomEnvironment()
  const originalCreate = useTaskStore.getState().createTask
  const calls: unknown[][] = []
  useTaskStore.setState({ createTask: async (...args) => {
    calls.push(args)
    return { id: 'new-task' } as Awaited<ReturnType<typeof originalCreate>>
  } })
  const project = { id: 'project', path: '/project', name: 'Project', workflows: [],
    steps: { nodes: [{ id: 'design', type: 'design', title: 'Design', autoStart: true }] } } as Project
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let closeCount = 0
  try {
    await act(async () => root.render(<I18nProvider><TaskCreatePanel
      project={project} workflowId="workflow"
      lanes={[{ key: 'design', label: 'Design', color: '#123456' }]}
      initialStepKey="design" onClose={() => { closeCount++ }}
    /></I18nProvider>))
    const createButton = container.querySelector<HTMLButtonElement>('.task-create-primary')!
    assert.equal(createButton.disabled, true)
    const title = container.querySelector<HTMLInputElement>('#new-task-title')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(title, 'New task')
      title.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(createButton.disabled, false)
    await act(async () => createButton.click())
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0]?.slice(0, 3), ['New task', '/project', 'project'])
    assert.equal(calls[0]?.[4], 'design')
    assert.equal(calls[0]?.[6], 'workflow')
    assert.equal(calls[0]?.[7], true)
    assert.equal(closeCount, 1)
  } finally {
    await act(async () => root.unmount())
    useTaskStore.setState({ createTask: originalCreate })
    container.remove()
    await window.happyDOM.close()
  }
})

test('discard confirmation stays with a changed task creation form', async () => {
  const { window } = installDomEnvironment()
  const project = { id: 'project', path: '/project', name: 'Project', workflows: [],
    steps: { nodes: [] } } as Project
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let closeCount = 0
  try {
    await act(async () => root.render(<I18nProvider><TaskCreatePanel
      project={project} workflowId="workflow"
      lanes={[{ key: 'do', label: 'Do', color: '#123456' }]}
      onClose={() => { closeCount++ }}
    /></I18nProvider>))
    const title = container.querySelector<HTMLInputElement>('#new-task-title')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(title, 'Draft')
      title.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await act(async () => container.querySelector<HTMLButtonElement>('.task-create-cancel')!.click())
    assert.equal(closeCount, 0)
    const confirm = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => /Discard|丢弃/.test(button.textContent || '') && !button.disabled)!
    assert.ok(confirm)
    await act(async () => confirm.click())
    assert.equal(closeCount, 1)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('scheduled creation submits the selected local time as the same ISO instant', async () => {
  const { window } = installDomEnvironment()
  Object.assign(globalThis, { SVGElement: window.SVGElement, ShadowRoot: window.ShadowRoot,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
  const originalCreate = taskApi.create
  const originalTasks = useTaskStore.getState().tasks
  const calls: unknown[][] = []
  taskApi.create = async (...args) => {
    calls.push(args)
    return { id: 'scheduled-task', scheduled_start_at: args[9] } as Awaited<ReturnType<typeof originalCreate>>
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><TaskCreatePanel project={{ id: 'project', path: '/project', name: 'Project', workflows: [], steps: { nodes: [] } } as Project}
      workflowId="workflow" lanes={[{ key: 'do', label: 'Do', color: '#123456' }]} onClose={() => {}} /></I18nProvider>))
    await act(async () => {
      const title = container.querySelector<HTMLInputElement>('#new-task-title')!
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(title, 'Scheduled task')
      title.dispatchEvent(new window.Event('input', { bubbles: true }))
      container.querySelector<HTMLInputElement>('input[value="scheduled"]')!.click()
    })
    const styles = document.head.appendChild(document.createElement('style'))
    const css = ['index.css', 'mobile.css'].map(file => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')).join('\n')
    const startOptions = container.querySelector<HTMLElement>('.task-create-start-options')!
    const previousWidth = window.innerWidth
    for (const width of [320, 390, 1023, 1024, 1440]) {
      window.innerWidth = width
      styles.textContent = css
      assert.equal(window.getComputedStyle(startOptions).gridTemplateColumns, width <= 1023 ? '1fr' : '1fr 1fr')
    }
    window.innerWidth = previousWidth
    styles.remove()
    assert.equal(container.querySelector<HTMLButtonElement>('.task-create-primary')!.disabled, true)
    await act(async () => container.querySelector<HTMLInputElement>('.ant-picker-input input')!.click())
    const preset = [...document.querySelectorAll<HTMLButtonElement>('.date-time-picker-preset')].find(button => /Next week|下周/.test(button.textContent || ''))!
    await act(async () => preset.click())
    const chosen = container.querySelector<HTMLInputElement>('.ant-picker-input input')!.value
    await act(async () => document.querySelector<HTMLButtonElement>('.ant-picker-ok')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.task-create-primary')!.click())
    assert.equal(calls.length, 1)
    assert.equal(calls[0][8], false)
    assert.equal(calls[0][9], new Date(chosen.replace(' ', 'T')).toISOString())
    assert.equal(utcToLocalDateTime(useTaskStore.getState().tasks.find(task => task.id === 'scheduled-task')!.scheduled_start_at), chosen.replace(' ', 'T'))
  } finally {
    await act(async () => root.unmount())
    taskApi.create = originalCreate
    useTaskStore.setState({ tasks: originalTasks })
    container.remove()
    await window.happyDOM.close()
  }
})


test('task creation blocks invalid review counts even when submitted from the title', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const originalCreate = useTaskStore.getState().createTask, previousFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ providers: [], buttons: [], assistants: [] })
  const calls: unknown[][] = []
  useTaskStore.setState({ createTask: async (...args) => { calls.push(args); return { id: 'new' } as any } })
  const project = { id: 'project', path: '/project', name: 'Project', workflows: [],
    steps: { nodes: [{ id: 'write', type: 'write', title: '撰写', review: { mode: 'auto', maxRetries: 2 } }] } } as Project
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  const set = (input: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  const tab = (value: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === value)!.click())
  try {
    await act(async () => root.render(<I18nProvider><TaskCreatePanel project={project} workflowId="workflow" lanes={[{ key: 'write', label: '撰写' }]} onClose={() => {}} /></I18nProvider>))
    await set(container.querySelector('#new-task-title')!, '输入修复')
    const create = container.querySelector<HTMLButtonElement>('.task-create-primary')!
    await tab('审核配置')
    for (const value of ['', '0', '6', '1.5']) {
      await set(container.querySelector('input[type="number"]')!, value)
      assert.equal(create.disabled, true)
    }
    await tab('任务内容')
    const title = container.querySelector<HTMLInputElement>('#new-task-title')!
    await act(async () => title.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    assert.equal(calls.length, 0)
    await tab('审核配置')
    await set(container.querySelector('input[type="number"]')!, '4')
    await act(async () => create.click())
    assert.equal(calls.length, 1)
    assert.equal((calls[0][5] as any).write.maxRetries, 4)
  } finally {
    await act(async () => root.unmount()); container.remove()
    useTaskStore.setState({ createTask: originalCreate }); globalThis.fetch = previousFetch
    await window.happyDOM.close()
  }
})

for (const mode of ['manual', 'skip'] as const) {
  test(`task creation ignores an empty hidden retry draft in ${mode} mode`, async () => {
    const { window } = installDomEnvironment()
    useLocaleStore.setState({ locale: 'zh-CN' })
    const originalCreate = useTaskStore.getState().createTask, previousFetch = globalThis.fetch
    globalThis.fetch = async () => Response.json({ providers: [], buttons: [], assistants: [] })
    const calls: unknown[][] = []
    useTaskStore.setState({ createTask: async (...args) => { calls.push(args); return { id: 'new' } as any } })
    const project = { id: 'project', path: '/project', name: 'Project', workflows: [], steps: { nodes: [{ id: 'write', type: 'write', title: '撰写', review: { mode: 'auto', maxRetries: 4 } }] } } as Project
    const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
    const set = (input: HTMLInputElement, value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!
    try {
      await act(async () => root.render(<I18nProvider><TaskCreatePanel project={project} workflowId="workflow" lanes={[{ key: 'write', label: '撰写' }]} onClose={() => {}} /></I18nProvider>))
      await set(container.querySelector('#new-task-title')!, '隐藏次数草稿')
      await act(async () => button('审核配置').click())
      await set(container.querySelector('input[type="number"]')!, '')
      const create = container.querySelector<HTMLButtonElement>('.task-create-primary')!
      assert.equal(create.disabled, true)
      await act(async () => button(mode === 'manual' ? '人工审核' : '跳过审核').click())
      assert.equal(container.querySelector('input[type="number"]') === null, true)
      assert.equal(create.disabled, false)
      await act(async () => create.click())
      assert.equal(calls.length, 1)
      const submitted = (calls[0][5] as any).write
      assert.equal(submitted.mode, mode)
      assert.equal(submitted.maxRetries, 4, 'submit retains the original legal count')
    } finally {
      await act(async () => root.unmount()); container.remove()
      useTaskStore.setState({ createTask: originalCreate }); globalThis.fetch = previousFetch
      await window.happyDOM.close()
    }
  })
}

test('mobile applies only the selected message content and preserves creation settings', async () => {
  const { window } = installDomEnvironment()
  window.innerWidth = 390
  Object.assign(globalThis, { history: window.history, location: window.location })
  const original = { list: assistantApi.list, providers: providerApi.list, chat: taskDraftApi.chat, create: useTaskStore.getState().createTask }
  const calls: unknown[][] = []
  let sid = ''
  const prompts: unknown[] = []
  assistantApi.list = async () => ({ assistants: [] })
  providerApi.list = async () => ({ providers: [] })
  taskDraftApi.chat = async (_project, _content, sessionId, _messageId, options) => {
    sid = sessionId!
    prompts.push(options)
    return { session_id: sid, turn_id: 'turn', assistant_message_id: prompts.length === 1 ? 'first' : 'second', status: 'running' }
  }
  useTaskStore.setState({ createTask: async (...args) => { calls.push(args); return { id: 'created' } as any } })
  const project = { id: 'project', path: '/project', name: 'Project', workflows: [],
    steps: { nodes: [{ id: 'design', type: 'design', autoStart: true, review: { mode: 'manual', prompt: '保留审核' } }] } } as Project
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const click = async (selector: string) => { await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click()) }
  const setInput = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    await act(async () => {
      const proto = input.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  }
  const result = async (id: string, description: string) => {
    await act(async () => {
      const store = useTaskDraftStore.getState()
      store.handleWsEvent({ type: 'TEXT_MESSAGE_START', channel: 'task_create', session_id: sid, messageId: id, role: 'assistant' })
      store.handleWsEvent({ type: 'CUSTOM', name: 'workstep.task_draft', channel: 'task_create', session_id: sid, messageId: id,
        value: { title: `标题${id}`, description, start_step_key: 'other', workflow_id: 'other-workflow' } })
      store.handleWsEvent({ type: 'TEXT_MESSAGE_END', channel: 'task_create', session_id: sid, messageId: id, content: '已整理需求' })
    })
  }
  try {
    await act(async () => root.render(<I18nProvider><TaskCreatePanel project={project} workflowId="workflow"
      lanes={[{ key: 'design', label: 'Design', color: '#123456' }, { key: 'other', label: 'Other', color: '#123456' }]}
      initialStepKey="design" onClose={() => {}} /></I18nProvider>))
    assert.equal(container.querySelector('.task-create-panel')?.getAttribute('data-tab'), 'assistant')
    await setInput(container.querySelector<HTMLTextAreaElement>('.chat-input-root textarea')!, '整理需求')
    await click('.chat-input-send')
    assert.ok(sid)
    await result('first', '## 完整草稿一\n\n- 验收一\n- 验收二')
    assert.equal(container.querySelectorAll('.task-draft-apply').length, 1)
    assert.equal(container.querySelector('.task-create-panel')?.getAttribute('data-tab'), 'assistant')
    await click('[data-message-id="first"] .task-draft-apply')
    assert.equal(container.querySelector('.task-create-panel')?.getAttribute('data-tab'), 'content')
    assert.equal(container.querySelector<HTMLInputElement>('#new-task-title')?.value, '标题first')
    assert.equal(container.querySelector<HTMLTextAreaElement>('.markdown-editor-input')?.value, '## 完整草稿一\n\n- 验收一\n- 验收二')
    await setInput(container.querySelector<HTMLInputElement>('#new-task-title')!, '用户标题')
    await click('.mobile-assistant-tab')
    await setInput(container.querySelector<HTMLTextAreaElement>('.chat-input-root textarea')!, '继续完善需求')
    await click('.chat-input-send')
    assert.equal((prompts[1] as any).title, '用户标题')
    assert.equal((prompts[1] as any).workflowId, 'workflow')
    assert.equal((prompts[1] as any).startStepKey, 'design')
    assert.equal(container.querySelectorAll('.task-draft-apply').length, 1)
    await result('second', '第二轮完整草稿')
    await result('invalid', '   ')
    assert.equal(container.querySelectorAll('.task-draft-apply').length, 2)
    await click('[data-message-id="second"] .task-draft-apply')
    assert.equal(container.querySelector<HTMLInputElement>('#new-task-title')?.value, '用户标题')
    assert.equal(container.querySelector<HTMLTextAreaElement>('.markdown-editor-input')?.value, '第二轮完整草稿')
    await click('.mobile-assistant-tab')
    await click('[data-message-id="first"] .task-draft-apply')
    assert.equal(container.querySelector<HTMLTextAreaElement>('.markdown-editor-input')?.value, '## 完整草稿一\n\n- 验收一\n- 验收二')
    assert.equal(calls.length, 0)
    await click('.task-create-primary')
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], '用户标题')
    assert.equal(calls[0][4], 'design')
    assert.equal((calls[0][5] as any).design.prompt, '保留审核')
    assert.equal(calls[0][6], 'workflow')
    assert.equal(calls[0][7], true)
  } finally {
    await act(async () => root.unmount())
    assistantApi.list = original.list; providerApi.list = original.providers; taskDraftApi.chat = original.chat
    useTaskStore.setState({ createTask: original.create })
    container.remove(); await window.happyDOM.close()
  }
})
