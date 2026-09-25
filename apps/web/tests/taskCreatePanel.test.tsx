import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Project } from '../src/api/client'
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
