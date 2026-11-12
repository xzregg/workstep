import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { scheduleApi, type Project, type Task } from '../src/api/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import TaskList from '../src/pages/TaskList'
import { useProjectStore } from '../src/stores/projectStore'
import { useTaskStore } from '../src/stores/taskStore'
import { useManagedModeStore } from '../src/stores/managedModeStore'

const makeTask = (id: string, status: string, extra: Partial<Task> = {}): Task => ({
  id, title: id, status, workflow_id: 'flow', description: null, cwd: '/demo', engine: 'codex',
  created_at: '2026-11-12T00:00:00Z', updated_at: '2026-11-12T00:00:00Z',
  steps: [{ step_key: 'do', status: 'pending', engine: null, started_at: null, ended_at: null, error: null }],
  ...extra,
})

test('status view groups real task states, retains card details, updates live and persists the selection', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.getState().setLocale('zh-CN')
  Object.assign(globalThis, { history: window.history })
  const projectState = useProjectStore.getState(), taskState = useTaskStore.getState(), managedState = useManagedModeStore.getState()
  const originalList = scheduleApi.list
  scheduleApi.list = async () => ({ schedules: [] })
  const tasks = [
    makeTask('ready', 'ready'), makeTask('queued', 'queued', { queue_position: 2 }),
    makeTask('running', 'running', { pending_confirmations: [{ step_key: 'do', reason: 'manual_review' }], steps: [{ step_key: 'do', status: 'running', engine: null, started_at: null, ended_at: null, error: null }] }),
    makeTask('waiting', 'waiting', { status_reason: 'tool_approval' }),
    makeTask('stopped', 'stopped'), makeTask('failed', 'failed', { status_reason: 'engine_error' }),
    makeTask('completed', 'completed'),
    makeTask('other-flow', 'ready', { workflow_id: 'other' }), makeTask('archived', 'failed', { archived: true }),
  ]
  useProjectStore.setState({ activeProject: { id: 'demo', name: 'Demo', path: '/demo', steps: {}, workflows: [{ id: 'flow', name: 'Flow' }] } as unknown as Project, activeWorkflowId: 'flow' })
  let fetches = 0
  useTaskStore.setState({ tasks, loading: false, listError: null, listQuery: { projectId: 'demo', workflowId: 'flow', archived: false }, fetchTasks: async () => { fetches++ } })
  useManagedModeStore.setState({ load: async () => {} })
  const container = document.body.appendChild(document.createElement('div'))
  let root = createRoot(container)
  const render = async () => act(async () => root.render(<MemoryRouter><I18nProvider><TaskList /></I18nProvider></MemoryRouter>))
  const lanes = () => [...container.querySelectorAll<HTMLElement>('.desktop-task-board .task-board-lane')]
  const laneIds = () => lanes().map(lane => [...lane.querySelectorAll<HTMLElement>('[data-task-status]')].map(card => card.querySelector('.task-board-card-title')!.textContent))
  try {
    await render()
    const statusButton = container.querySelector<HTMLButtonElement>('[aria-label="状态泳道"]')
    assert.ok(statusButton, 'status view is available alongside the existing two views')
    await act(async () => statusButton.click())
    assert.equal(statusButton.getAttribute('aria-pressed'), 'true')
    assert.ok(container.querySelector('.desktop-task-toolbar .btn-primary'), 'global task creation remains available in status view')
    assert.deepEqual(lanes().map(lane => lane.querySelector('.task-board-lane-heading')!.textContent), ['预备中(2)', '运行中(1)', '等待确认(1)', '已中断(2)', '已完成(1)'])
    assert.deepEqual(laneIds(), [['ready', 'queued'], ['running'], ['waiting'], ['stopped', 'failed'], ['completed']])
    assert.ok(container.querySelector('[data-s="queued"]'))
    assert.ok(container.querySelector('[data-s="tool_approval"]'))
    assert.match(lanes()[3].textContent!, /引擎调用失败/)
    assert.ok(lanes()[1].querySelector('.task-status-spinner'))
    assert.equal(lanes()[2].querySelector('.task-status-spinner'), null)
    assert.ok(lanes().every(lane => !lane.querySelector('.task-board-lane-add')))
    assert.ok([...container.querySelectorAll('.desktop-task-board .task-board-card')].every(card => card.getAttribute('draggable') === 'false'))
    assert.equal(fetches, 1, 'changing view does not fetch tasks again')
    assert.equal(localStorage.getItem('workstep.boardView'), 'status')
    await act(async () => useTaskStore.setState({ tasks: tasks.map(task => task.id === 'ready' ? { ...task, status: 'waiting', status_reason: 'manual_review' } : task) }))
    assert.deepEqual(laneIds(), [['queued'], ['running'], ['ready', 'waiting'], ['stopped', 'failed'], ['completed']])
    await act(async () => root.unmount())
    root = createRoot(container)
    await render()
    assert.equal(container.querySelector('[aria-label="状态泳道"]')!.getAttribute('aria-pressed'), 'true')
    await act(async () => useTaskStore.setState({ tasks: [] }))
    assert.equal(lanes().length, 5, 'empty status lanes stay visible')
    assert.ok(lanes().every(lane => lane.querySelector('.task-board-lane-count')!.textContent === '(0)'))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="步骤泳道"]')!.click())
    assert.equal(lanes().length, 1)
    assert.ok(container.querySelector('.task-board-lane-add'))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="表格"]')!.click())
    assert.ok(container.querySelector('.task-board-table'))
  } finally {
    await act(async () => root.unmount())
    useProjectStore.setState(projectState, true)
    useTaskStore.setState(taskState, true)
    useManagedModeStore.setState(managedState, true)
    scheduleApi.list = originalList
    container.remove()
    await window.happyDOM.close()
  }
})
