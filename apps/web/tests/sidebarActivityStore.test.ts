import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'

import {
  deriveSessionFailedState,
  deriveWorkflowFailedState,
  deriveWorkflowRunningState,
  useSidebarActivityStore,
} from '../src/stores/sidebarActivityStore.ts'
import {
  SIDEBAR_ACTIVITY_STATE_KEY,
  loadSidebarActivityReadState,
  saveSidebarActivityReadState,
} from '../src/utils/sidebarActivityState.ts'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

test('workflow running state follows active-project task events without a project refresh', () => {
  const projects = [{
    id: 'project-1',
    workflows: [{ id: 'workflow-1', running: false }],
  }]
  assert.deepEqual(
    deriveWorkflowRunningState(projects, [{ workflow_id: 'workflow-1', status: 'running' }], 'project-1'),
    { 'workflow-1': true },
  )
  assert.deepEqual(
    deriveWorkflowRunningState(
      [{ ...projects[0], workflows: [{ id: 'workflow-1', running: true }] }],
      [{ workflow_id: 'workflow-1', status: 'ready' }],
      'project-1',
    ),
    { 'workflow-1': false },
  )
})

test('workflow failure follows failed task stages and falls back to project summaries', () => {
  const projects = [{
    id: 'project-1',
    workflows: [
      { id: 'workflow-live', failed: false },
      { id: 'workflow-snapshot', failed: true },
    ],
  }]
  const tasks = [{
    workflow_id: 'workflow-live',
    steps: [{ status: 'failed' }],
  }]

  assert.deepEqual(deriveWorkflowFailedState(projects, tasks, 'project-1'), {
    'workflow-live': true,
    'workflow-snapshot': true,
  })
})

test('session failure uses the latest live message over a stale list summary', () => {
  const sessions = [
    { id: 'failed-from-list', last_message_status: 'error' },
    { id: 'cleared-live', last_message_status: 'error' },
  ]
  const liveSessions = {
    'cleared-live': { messages: [{ status: 'succeeded' }] },
    'failed-live': { messages: [{ status: 'error' }] },
  }

  assert.deepEqual(deriveSessionFailedState(sessions, liveSessions), {
    'failed-from-list': true,
    'cleared-live': false,
    'failed-live': true,
  })
})

test('completed workflow and chat session remain unread until opened', () => {
  useSidebarActivityStore.setState({ completedWorkflows: {}, completedSessions: {} })
  const store = useSidebarActivityStore.getState()

  store.markWorkflowCompleted('project-1', 'workflow-1')
  store.markSessionCompleted('session-1')

  assert.equal(useSidebarActivityStore.getState().completedWorkflows['workflow-1'], 'project-1')
  assert.equal(useSidebarActivityStore.getState().completedSessions['session-1'], true)

  store.markWorkflowRead('workflow-1')
  store.markSessionRead('session-1')
  assert.deepEqual(useSidebarActivityStore.getState().completedWorkflows, {})
  assert.deepEqual(useSidebarActivityStore.getState().completedSessions, {})
})

test('opening a project clears every completed workflow notice in that project', () => {
  useSidebarActivityStore.setState({ completedWorkflows: {}, completedSessions: {} })
  const store = useSidebarActivityStore.getState()
  store.markWorkflowCompleted('project-1', 'workflow-1')
  store.markWorkflowCompleted('project-1', 'workflow-2')
  store.markWorkflowCompleted('project-2', 'workflow-3')

  store.markProjectRead('project-1')

  assert.deepEqual(useSidebarActivityStore.getState().completedWorkflows, {
    'workflow-3': 'project-2',
  })
})

test('acknowledgements round-trip through storage so a reload keeps the dot dark', () => {
  const storage = memoryStorage()
  saveSidebarActivityReadState({
    readFailedWorkflows: { 'workflow-1': true },
    readFailedSessions: { 'session-1': true },
    readFailedProjects: { 'project-1': true },
  }, storage)

  // Simulates the store's initial state after a page refresh.
  assert.deepEqual(loadSidebarActivityReadState(storage), {
    readFailedWorkflows: { 'workflow-1': true },
    readFailedSessions: { 'session-1': true },
    readFailedProjects: { 'project-1': true },
  })
})

test('persisted acknowledgements ignore malformed payloads and non-true markers', () => {
  const storage = memoryStorage()
  storage.setItem(SIDEBAR_ACTIVITY_STATE_KEY, '{ not json')
  assert.deepEqual(loadSidebarActivityReadState(storage), {
    readFailedWorkflows: {},
    readFailedSessions: {},
    readFailedProjects: {},
  })

  storage.setItem(SIDEBAR_ACTIVITY_STATE_KEY, JSON.stringify({
    readFailedSessions: { 'session-1': true, 'session-2': 'yes', 'session-3': null },
    readFailedWorkflows: ['workflow-1'],
  }))
  assert.deepEqual(loadSidebarActivityReadState(storage), {
    readFailedWorkflows: {},
    readFailedSessions: { 'session-1': true },
    readFailedProjects: {},
  })
})

test('persisted acknowledgements stay bounded, evicting the oldest entries', () => {
  const storage = memoryStorage()
  const readFailedSessions = Object.fromEntries(
    Array.from({ length: 400 }, (_, index) => [`session-${index}`, true as const]),
  )
  saveSidebarActivityReadState(
    { readFailedWorkflows: {}, readFailedSessions, readFailedProjects: {} },
    storage,
  )

  const restored = loadSidebarActivityReadState(storage).readFailedSessions
  assert.equal(Object.keys(restored).length, 300)
  assert.equal(restored['session-0'], undefined)
  assert.equal(restored['session-100'], true)
  assert.equal(restored['session-399'], true)
})

test('store writes acknowledgements through to browser storage', () => {
  const window = new Window({ url: 'http://localhost/chat' })
  const originalWindow = (globalThis as { window?: unknown }).window
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true })
  try {
    window.localStorage.clear()
    useSidebarActivityStore.setState({
      readFailedWorkflows: {},
      readFailedSessions: {},
      readFailedProjects: {},
    })

    useSidebarActivityStore.getState().markSessionRead('session-1')
    useSidebarActivityStore.getState().markWorkflowRead('workflow-1')
    useSidebarActivityStore.getState().markProjectRead('project-1', ['workflow-1'], ['session-1'])

    assert.deepEqual(loadSidebarActivityReadState(window.localStorage), {
      readFailedWorkflows: { 'workflow-1': true },
      readFailedSessions: { 'session-1': true },
      readFailedProjects: { 'project-1': true },
    })

    // Clearing a marker must reach storage too, or the dot stays dark forever.
    useSidebarActivityStore.getState().markSessionStarted('session-1')
    assert.equal(
      loadSidebarActivityReadState(window.localStorage).readFailedSessions['session-1'],
      undefined,
    )

    useSidebarActivityStore.setState({ readFailedProjects: { 'project-1': true } })
    useSidebarActivityStore.getState().markProjectUnread('project-1')
    assert.deepEqual(
      loadSidebarActivityReadState(window.localStorage).readFailedProjects,
      {},
    )
  } finally {
    Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true })
    void window.happyDOM.close()
  }
})

test('resetResolvedFailures drops stale markers and is a no-op when nothing resolved', () => {
  useSidebarActivityStore.setState({
    readFailedWorkflows: { 'workflow-resolved': true, 'workflow-still-failed': true },
    readFailedSessions: { 'session-unknown': true },
    readFailedProjects: {},
  })
  const before = useSidebarActivityStore.getState().readFailedSessions

  useSidebarActivityStore.getState().resetResolvedFailures(
    { 'workflow-resolved': false, 'workflow-still-failed': true },
    {},
  )

  const after = useSidebarActivityStore.getState()
  assert.deepEqual(after.readFailedWorkflows, { 'workflow-still-failed': true })
  // No failure data for this session (its project is not loaded): keep the marker.
  assert.equal(after.readFailedSessions, before)
})
