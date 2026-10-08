import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { projectActionApi, taskActionApi, type ActionRun } from '../src/api/client'
import { ActionConversationMessage } from '../src/components/TaskActionShortcuts'
import { useProjectActions, useTaskActions } from '../src/components/useActionRuns'
import { I18nProvider } from '../src/i18n'

const activeRun = {
  run_id: 'run-1', task_id: null, session_id: 'session-1', action_id: 'restart',
  button_id: 'restart', source: 'project', title: '重启', script_path: 'restart.sh',
  cwd: '/tmp/project', status: 'running', output: '', exit_code: null,
  user_message_id: 'user-1', reply_message_id: 'reply-1',
  started_at: '', ended_at: null,
} as ActionRun

test('Action reply uses a chat message bubble with output and stop control', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const stopped: string[] = []
  try {
    await act(async () => root.render(<I18nProvider><ActionConversationMessage
      message={{ id: 'reply-1', role: 'assistant', content: '' }}
      run={{ ...activeRun, output: 'http://localhost:3000' }}
      onStop={(runId) => stopped.push(runId)}
    /></I18nProvider>))
    assert.ok(container.querySelector('.chat-message-row'))
    assert.match(container.textContent || '', /http:\/\/localhost:3000/)
    const stop = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('停止'))
    assert.ok(stop)
    await act(async () => stop.click())
    assert.deepEqual(stopped, ['run-1'])
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('Action message shows final duration first on the left for terminal statuses', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    for (const status of ['succeeded', 'failed', 'stopped', 'timed_out', 'interrupted']) {
      await act(async () => root.render(<I18nProvider><ActionConversationMessage
        message={{ id: 'reply-1', role: 'assistant', content: '' }}
        run={{ ...activeRun, status, started_at: '2026-10-08T00:00:00Z', ended_at: '2026-10-08T00:01:07Z' }}
      /></I18nProvider>))
      const duration = container.querySelector('.action-conversation-duration')
      assert.equal(duration?.textContent, 'Duration 1m7s')
      assert.equal(duration?.parentElement?.firstElementChild, duration)
    }
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('running Action updates duration and releases its clock when finished', async () => {
  const { window } = installDomEnvironment()
  const originalNow = Date.now
  const originalInterval = window.setInterval
  const originalClear = window.clearInterval
  let now = Date.parse('2026-10-08T00:00:05Z')
  const timers = new Map<number, () => void>()
  Date.now = () => now
  window.setInterval = ((callback: () => void) => { timers.set(1, callback); return 1 }) as typeof window.setInterval
  window.clearInterval = ((id: number) => { timers.delete(id) }) as typeof window.clearInterval
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const render = (run: ActionRun) => root.render(<I18nProvider><ActionConversationMessage
    message={{ id: 'reply-1', role: 'assistant', content: '' }} run={run}
  /></I18nProvider>)
  try {
    const run = { ...activeRun, started_at: '2026-10-08T00:00:00Z' }
    await act(async () => render(run))
    const duration = () => container.querySelector('.action-conversation-duration')?.textContent
    assert.equal(duration(), 'Duration 5s')
    now += 3000
    await act(async () => timers.get(1)?.())
    assert.equal(duration(), 'Duration 8s')
    await act(async () => render({ ...run, status: 'succeeded', ended_at: '2026-10-08T00:00:07Z' }))
    assert.equal(duration(), 'Duration 7s')
    assert.equal(timers.size, 0)
    await act(async () => render({ ...run, started_at: '' }))
    assert.equal(duration(), undefined)
  } finally {
    await act(async () => root.unmount())
    Date.now = originalNow
    window.setInterval = originalInterval
    window.clearInterval = originalClear
    container.remove()
    await window.happyDOM.close()
  }
})

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

test('task shortcuts reload when the selected step changes during an earlier request', async () => {
  const { window } = installDomEnvironment()
  const originalList = taskActionApi.list
  const requests: Array<{ step: string | undefined; resolve: (value: Awaited<ReturnType<typeof taskActionApi.list>>) => void }> = []
  taskActionApi.list = async (_taskId, _projectId, step) => new Promise((resolve) => {
    requests.push({ step, resolve })
  })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  function Harness({ step }: { step?: string }) {
    const state = useTaskActions('project-1', 'task-1', step)
    return <div>{state.buttons.map((button) => button.label).join(',')}</div>
  }
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    await act(async () => root.render(<I18nProvider><Harness step="review" /></I18nProvider>))
    assert.deepEqual(requests.map((request) => request.step), [undefined, 'review'])
    await act(async () => {
      requests[1].resolve({ buttons: [{ id: 'workflow-review', label: '流程按钮', prompt: '继续', kind: 'prompt', source: 'workflow' }], runs: [] })
    })
    assert.equal(container.textContent, '流程按钮')
    await act(async () => requests[0].resolve({ buttons: [], runs: [] }))
    assert.equal(container.textContent, '流程按钮')
  } finally {
    await act(async () => root.unmount())
    taskActionApi.list = originalList
    container.remove()
    await window.happyDOM.close()
  }
})

test('project Actions reload when the session changes during an earlier request', async () => {
  const { window } = installDomEnvironment()
  const originalList = projectActionApi.list
  const requests: Array<{ session: string; resolve: (value: Awaited<ReturnType<typeof projectActionApi.list>>) => void }> = []
  projectActionApi.list = async (session) => new Promise((resolve) => {
    requests.push({ session, resolve })
  })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  function Harness({ session }: { session: string }) {
    const state = useProjectActions('project-1', session)
    return <div>{state.runs.map((run) => run.title).join(',')}</div>
  }
  try {
    await act(async () => root.render(<I18nProvider><Harness session="first" /></I18nProvider>))
    await act(async () => root.render(<I18nProvider><Harness session="second" /></I18nProvider>))
    assert.deepEqual(requests.map((request) => request.session), ['first', 'second'])
    await act(async () => requests[1].resolve({ buttons: [], runs: [{ ...activeRun, title: '新会话' }], active_action_ids: [] }))
    assert.equal(container.textContent, '新会话')
    await act(async () => requests[0].resolve({ buttons: [], runs: [{ ...activeRun, title: '旧会话' }], active_action_ids: [] }))
    assert.equal(container.textContent, '新会话')
  } finally {
    await act(async () => root.unmount())
    projectActionApi.list = originalList
    container.remove()
    await window.happyDOM.close()
  }
})

test('existing task refreshes shortcut buttons when its tab regains focus', async () => {
  const { window } = installDomEnvironment()
  const originalList = taskActionApi.list
  let currentLabel = '旧按钮'
  let calls = 0
  taskActionApi.list = async () => {
    calls += 1
    return { buttons: [{ id: 'workflow-button', label: currentLabel, prompt: '继续', kind: 'prompt', source: 'workflow' }], runs: [] }
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  function Harness() {
    const state = useTaskActions('project-1', 'existing-task', 'build')
    return <div>{state.buttons.map((button) => button.label).join(',')}</div>
  }
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    assert.equal(container.textContent, '旧按钮')
    currentLabel = '新增按钮'
    await act(async () => window.dispatchEvent(new window.Event('focus')))
    assert.equal(calls, 2)
    assert.equal(container.textContent, '新增按钮')
    currentLabel = '再次更新'
    await act(async () => document.dispatchEvent(new window.Event('visibilitychange')))
    assert.equal(calls, 3)
    assert.equal(container.textContent, '再次更新')
  } finally {
    await act(async () => root.unmount())
    taskActionApi.list = originalList
    container.remove()
    await window.happyDOM.close()
  }
})
