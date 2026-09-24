import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { projectActionApi, taskActionApi, type ActionRun } from '../src/api/client'
import { useProjectActions } from '../src/components/ProjectActionMessages'
import { useTaskActions } from '../src/components/TaskActionShortcuts'
import { I18nProvider } from '../src/i18n'

const activeRun = {
  run_id: 'run-1', task_id: null, session_id: 'session-1', action_id: 'restart',
  button_id: 'restart', source: 'project', title: '重启', script_path: 'restart.sh',
  cwd: '/tmp/project', status: 'running', output: '', exit_code: null,
  user_message_id: 'user-1', reply_message_id: 'reply-1',
  started_at: '', ended_at: null,
} as ActionRun

test('project Action only polls while an Action is active', async () => {
  const { window } = installDomEnvironment()
  const originalList = projectActionApi.list
  const originalRun = projectActionApi.run
  const originalSetInterval = window.setInterval
  const originalClearInterval = window.clearInterval
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  let listCalls = 0
  let active = false
  window.setInterval = ((callback: () => void) => {
    const id = nextTimer++
    timers.set(id, callback)
    return id
  }) as typeof window.setInterval
  window.clearInterval = ((id: number) => { timers.delete(id) }) as typeof window.clearInterval
  projectActionApi.list = async () => {
    listCalls += 1
    return { buttons: [], runs: active ? [activeRun] : [], active_action_ids: active ? ['restart'] : [] }
  }
  projectActionApi.run = async () => activeRun
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let state: ReturnType<typeof useProjectActions>
  function Harness() {
    state = useProjectActions('project-1', 'session-1')
    return null
  }
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    assert.equal(listCalls, 1)
    assert.equal(timers.size, 0, 'idle session must not poll')

    active = true
    await act(async () => { await state!.run({ id: 'restart', label: '重启', prompt: '', kind: 'action', action_id: 'restart', require_confirmation: false }) })
    assert.equal(timers.size, 1, 'running Action should poll')

    active = false
    await act(async () => { await [...timers.values()][0]() })
    assert.equal(timers.size, 0, 'polling stops after Action completes')
  } finally {
    await act(async () => root.unmount())
    projectActionApi.list = originalList
    projectActionApi.run = originalRun
    window.setInterval = originalSetInterval
    window.clearInterval = originalClearInterval
    container.remove()
    await window.happyDOM.close()
  }
})

test('task Action does not poll when no Action is running', async () => {
  const { window } = installDomEnvironment()
  const originalList = taskActionApi.list
  const originalSetInterval = window.setInterval
  let intervalCalls = 0
  window.setInterval = ((_callback: () => void) => { intervalCalls += 1; return intervalCalls }) as typeof window.setInterval
  taskActionApi.list = async () => ({ buttons: [], runs: [] })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  function Harness() {
    useTaskActions('project-1', 'task-1', 'build')
    return null
  }
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    assert.equal(intervalCalls, 0)
  } finally {
    await act(async () => root.unmount())
    taskActionApi.list = originalList
    window.setInterval = originalSetInterval
    container.remove()
    await window.happyDOM.close()
  }
})
