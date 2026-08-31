import assert from 'node:assert/strict'
import test from 'node:test'

import { useSidebarActivityStore } from '../src/stores/sidebarActivityStore.ts'

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
