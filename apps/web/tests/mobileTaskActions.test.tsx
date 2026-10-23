import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { scheduleApi, type Project, type Task } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import TaskList from '../src/pages/TaskList'
import { useProjectStore } from '../src/stores/projectStore'
import { useTaskStore } from '../src/stores/taskStore'
import { useManagedModeStore } from '../src/stores/managedModeStore'

test('mobile board confirms start, uses the selected project, and exposes failures; copy can retry', async () => {
  const { window } = installDomEnvironment()
  Object.assign(globalThis, { history: window.history })
  window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as any
  const projectState = useProjectStore.getState(), taskState = useTaskStore.getState(), managedState = useManagedModeStore.getState()
  const originalList = scheduleApi.list
  const calls: unknown[][] = []
  let failStart = false, failCopy = true
  scheduleApi.list = async () => ({ schedules: [] })
  useProjectStore.setState({ activeProject: { id: 'demo', name: 'Demo', path: '/demo', steps: {}, workflows: [{ id: 'flow', name: 'Flow' }] } as unknown as Project, activeWorkflowId: 'flow' })
  const task = { id: 'task', title: 'Demo task', status: 'ready', workflow_id: 'flow', steps: [{ step_key: 'do', status: 'pending', started_at: null }], created_at: '2026-10-01' } as Task
  useTaskStore.setState({ tasks: [task], loading: false, listQuery: { projectId: 'demo', workflowId: 'flow', archived: false }, fetchTasks: async () => {},
    runTask: async (...args) => { calls.push(args); if (failStart) throw new Error('start failed demo') },
    copyTask: async (...args) => { calls.push(args); if (failCopy) throw new Error('copy failed demo'); return task },
  })
  useManagedModeStore.setState({ load: async () => {} })
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  const openMenu = async () => act(async () => container.querySelector('.mobile-task-row')!.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><TaskList /></I18nProvider></MemoryRouter>))
    await openMenu()
    await act(async () => document.querySelector<HTMLButtonElement>('.mobile-task-menu [data-task-action="start"]')!.click())
    assert.equal(document.querySelector('.mobile-task-menu'), null)
    assert.ok(document.querySelector('.confirm-dialog-panel'))
    assert.deepEqual(calls, [])
    await act(async () => document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click())
    assert.deepEqual(calls, [['task', '', 'demo']])
    failStart = true
    await openMenu()
    await act(async () => document.querySelector<HTMLButtonElement>('.mobile-task-menu [data-task-action="start"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click())
    assert.match(container.querySelector('.mobile-task-notice')!.textContent || '', /start failed demo/)
    await openMenu()
    await act(async () => document.querySelector<HTMLButtonElement>('.mobile-task-menu [data-task-action="copy"]')!.click())
    assert.match(document.querySelector('.mobile-task-menu [role="alert"]')!.textContent || '', /copy failed demo/)
    failCopy = false
    await act(async () => document.querySelector<HTMLButtonElement>('.mobile-task-menu [data-task-action="copy"]')!.click())
    assert.equal(document.querySelector('.mobile-task-menu'), null)
    assert.equal(calls[2][0], 'task')
    assert.equal(calls[2][2], 'demo')
  } finally {
    await act(async () => root.unmount())
    useProjectStore.setState(projectState, true); useTaskStore.setState(taskState, true); useManagedModeStore.setState(managedState, true)
    scheduleApi.list = originalList
    await window.happyDOM.close()
  }
})
