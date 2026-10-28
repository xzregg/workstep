import assert from 'node:assert/strict'
import test from 'node:test'
import { taskDisplayStatus } from '../src/utils/taskDisplayStatus'
import { useTaskStore } from '../src/stores/taskStore'

test('parallel execution stays running while retaining a manual decision', () => {
  const steps = [{ step_key: 'backend', status: 'awaiting_review' }, { step_key: 'frontend', status: 'running' }]
  assert.equal(taskDisplayStatus('running', steps, false, 'execution').displayStatus, 'running')
  useTaskStore.setState({ tasks: [{ id: 'task-1', status: 'running', steps } as any], events: {}, liveMessages: {}, content: {} })
  useTaskStore.getState().handleWsEvent({ type: 'CUSTOM', name: 'workstep.status', task_id: 'task-1',
    step_key: 'backend', value: { status: 'awaiting_review', step_key: 'backend' } })
  assert.equal(useTaskStore.getState().tasks[0].status, 'running')
})

test('task-scoped status carries its reason and outstanding confirmations', () => {
  useTaskStore.setState({ tasks: [{ id: 'task-1', status: 'running', steps: [] } as any], events: {}, liveMessages: {}, content: {} })
  const pending = [{ step_key: 'backend', reason: 'manual_review' }]
  useTaskStore.getState().handleWsEvent({ type: 'CUSTOM', name: 'workstep.status', task_id: 'task-1',
    value: { status: 'waiting', status_reason: 'manual_review', pending_confirmations: pending } })
  assert.equal(useTaskStore.getState().tasks[0].status, 'waiting')
  assert.equal(useTaskStore.getState().tasks[0].status_reason, 'manual_review')
  assert.deepEqual(useTaskStore.getState().tasks[0].pending_confirmations, pending)
  useTaskStore.getState().handleWsEvent({ type: 'RUN_ERROR', task_id: 'task-1', status: 'failed', status_reason: 'engine_error' })
  assert.equal(useTaskStore.getState().tasks[0].status, 'failed')
  useTaskStore.getState().handleWsEvent({ type: 'RUN_FINISHED', task_id: 'task-1', status: 'stopped', status_reason: 'user_stop' })
  assert.equal(useTaskStore.getState().tasks[0].status, 'stopped')
})

test('explicit stop or failure cannot be hidden by a historical review wait', () => {
  const steps = [{ status: 'awaiting_review' }]
  assert.equal(taskDisplayStatus('stopped', steps, false, 'user_stop').displayStatus, 'stopped')
  assert.equal(taskDisplayStatus('failed', steps, false, 'engine_error').displayStatus, 'failed')
  assert.equal(taskDisplayStatus('waiting', steps, false, 'manual_review').displayStatus, 'awaiting_review')
  assert.equal(taskDisplayStatus('waiting', [], false, 'tool_approval').displayStatus, 'tool_approval')
})

test('downstream waiting for rework does not hide the manual review blocking it', () => {
  const steps = [{ step_key: 'test', status: 'awaiting_review' }, { step_key: 'publish', status: 'rework_waiting' }]
  assert.equal(taskDisplayStatus('paused', steps, false).displayStatus, 'awaiting_review')
  useTaskStore.setState({ tasks: [{ id: 'task-1', status: 'running', steps } as any], events: {}, liveMessages: {}, content: {} })
  useTaskStore.getState().handleWsEvent({ type: 'CUSTOM', name: 'workstep.status', task_id: 'task-1',
    step_key: 'test', value: { status: 'awaiting_review', step_key: 'test' } })
  assert.equal(useTaskStore.getState().tasks[0].status, 'waiting')
  assert.equal(useTaskStore.getState().tasks[0].status_reason, 'manual_review')
})

test('tool approval aggregate updates the step hint and clears it on response', () => {
  useTaskStore.setState({ tasks: [{ id: 'task-1', status: 'running', steps: [{ step_key: 'backend', status: 'running' }] } as any], events: {}, liveMessages: {}, content: {} })
  useTaskStore.getState().handleWsEvent({ type: 'CUSTOM', name: 'workstep.status', task_id: 'task-1',
    value: { status: 'waiting', status_reason: 'tool_approval', pending_confirmations: [
      { step_key: 'backend', reason: 'tool_approval', interaction_id: 'approve-1' },
    ] } })
  assert.equal(useTaskStore.getState().tasks[0].steps[0].waiting_reason, 'tool_approval')
  useTaskStore.getState().handleWsEvent({ type: 'RUN_STARTED', task_id: 'task-1', status: 'running', status_reason: 'execution', pending_confirmations: [] })
  assert.equal(useTaskStore.getState().tasks[0].steps[0].waiting_reason, null)
})
