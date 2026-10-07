import assert from 'node:assert/strict'
import test from 'node:test'
import type { Task } from '../src/api/client'
import { useTaskStore } from '../src/stores/taskStore'

test('return statuses update only selected steps and preserve visible failure reasons', () => {
  useTaskStore.setState({ tasks: [{ id: 'repair', status: 'running', steps: [
    { step_key: 'frontend', status: 'passed', error: '旧错误' },
    { step_key: 'backend', status: 'passed' },
    { step_key: 'test', status: 'passed' },
  ] } as Task] })
  for (const [step, status] of [['frontend', 'rework'], ['test', 'rework_waiting']]) {
    useTaskStore.getState().handleWsEvent({ type: 'CUSTOM', name: 'workstep.status',
      task_id: 'repair', step_key: step, value: { status, task_id: 'repair', step_key: step } })
  }
  const task = useTaskStore.getState().tasks[0]
  assert.equal(task.status, 'running')
  assert.equal(task.steps?.[0].status, 'rework')
  assert.equal(task.steps?.[0].error, null)
  assert.equal(task.steps?.[1].status, 'passed')
  assert.equal(task.steps?.[2].status, 'rework_waiting')
  useTaskStore.getState().handleWsEvent({ type: 'RUN_ERROR', task_id: 'repair',
    step_key: 'frontend', status: 'failed', error: '后端开发缺少 API 文档' })
  assert.equal(useTaskStore.getState().tasks[0].steps?.[0].error, '后端开发缺少 API 文档')
})
