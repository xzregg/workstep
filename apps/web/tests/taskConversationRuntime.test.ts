import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import * as taskDetailChat from '../src/pages/taskDetailChat.ts'
import { useProjectStore } from '../src/stores/projectStore.ts'
import { useTaskStore } from '../src/stores/taskStore.ts'

const taskDetailSource = await readFile(
  new URL('../src/components/TaskDetailView.tsx', import.meta.url),
  'utf8',
)
const layoutSource = await readFile(
  new URL('../src/components/Layout.tsx', import.meta.url),
  'utf8',
)

test('a running task keeps the composer editable for live message insertion and exposes stop', () => {
  const resolveTaskComposerState = (taskDetailChat as Record<string, any>).resolveTaskComposerState
  assert.equal(typeof resolveTaskComposerState, 'function')
  assert.deepEqual(
    resolveTaskComposerState({ target: 'step', stepRunning: true, prompt: '' }),
    { disabled: false, running: true },
  )
  assert.deepEqual(
    resolveTaskComposerState({ target: 'step', stepRunning: true, prompt: '补充约束' }),
    { disabled: false, running: false },
  )
  assert.match(taskDetailSource, /resolveTaskComposerState/)
  assert.match(taskDetailSource, /onStop=\{/)
})

test('the last completed step response renders its output artifacts', () => {
  assert.match(taskDetailSource, /isLastExecutionResponse/)
  assert.match(taskDetailSource, /\['succeeded', 'completed'\]\.includes/)
  assert.match(taskDetailSource, /renderMessageArtifacts\(\s*msgArtifacts/)
  assert.match(taskDetailSource, /artifact\.step_key === stepKey/)
})

test('historical step messages display their own engine session id', () => {
  assert.match(taskDetailSource, /msg\.session_id \|\|/)
  assert.match(taskDetailSource, /msg\.run_status === 'running'/)
})

test('refreshing a running task upserts it into an empty store', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 'task-running',
    title: '运行中任务',
    description: null,
    cwd: '/tmp',
    status: 'running',
    engine: 'codex',
    created_at: '2026-08-31T00:00:00Z',
    updated_at: '2026-08-31T00:00:01Z',
    steps: [{ step_key: 'implement', status: 'running' }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  useTaskStore.setState({ tasks: [] })
  try {
    await useTaskStore.getState().refreshTask('task-running', 'project-1')
    assert.equal(useTaskStore.getState().tasks[0]?.status, 'running')
    assert.equal(useTaskStore.getState().tasks[0]?.steps[0]?.status, 'running')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('project hydration updates the active project running indicators after refresh', async () => {
  const stale = {
    id: 'project-1', path: '/tmp/project-1', name: 'project-1', steps: {},
    workflows: [{ id: 'workflow-1', name: '默认', is_default: true, nodeCount: 1, running: false }],
  }
  const fresh = {
    ...stale,
    workflows: [{ ...stale.workflows[0], running: true }],
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ projects: [fresh] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
  useProjectStore.setState({ projects: [stale], activeProject: stale, loading: false })
  try {
    await useProjectStore.getState().fetchProjects()
    assert.equal(useProjectStore.getState().projects[0].workflows[0].running, true)
    assert.equal(useProjectStore.getState().activeProject?.workflows[0].running, true)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.match(layoutSource, /workflow\.running/)
})
