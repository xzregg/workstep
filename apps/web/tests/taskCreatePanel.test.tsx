import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { taskApi, type Project } from '../src/api/client'
import { utcToLocalDateTime } from '../src/utils/scheduledStart'
import { I18nProvider } from '../src/i18n'
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
