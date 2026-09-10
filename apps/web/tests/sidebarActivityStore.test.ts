import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deriveWorkflowRunningState,
  useSidebarActivityStore,
} from '../src/stores/sidebarActivityStore.ts'

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
