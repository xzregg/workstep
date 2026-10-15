import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { taskApi, type Task } from '../src/api/client'
import { useTaskStore } from '../src/stores/taskStore'

test('task metadata notifications refresh only the changed task from its project', async () => {
  const original = taskApi.get
  const state = useTaskStore.getState()
  const calls: string[][] = []
  taskApi.get = async (id, project) => {
    calls.push([id, project])
    return { id, title: 'Updated', description: 'Updated description', steps: [] } as unknown as Task
  }
  useTaskStore.setState({ tasks: [{ id: 'task', title: 'Before' }] as Task[] })
  try {
    useTaskStore.getState().handleWsEvent({ type: 'CUSTOM', name: 'workstep.task_updated',
      task_id: 'task', project_id: 'project', value: {} })
    await Promise.resolve()
    assert.deepEqual(calls, [['task', 'project']])
    assert.equal(useTaskStore.getState().tasks[0].description, 'Updated description')
  } finally { taskApi.get = original; useTaskStore.setState(state) }
})
