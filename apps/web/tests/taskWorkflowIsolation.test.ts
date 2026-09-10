import assert from 'node:assert/strict'
import test from 'node:test'
import { taskApi, type Task } from '../src/api/client.ts'
import { useTaskStore } from '../src/stores/taskStore.ts'
import * as taskStore from '../src/stores/taskStore.ts'

test('reconnect refresh preserves the board workflow and archive filter', async () => {
  const original = taskApi.list
  const calls: unknown[][] = []
  taskApi.list = async (...args) => {
    calls.push(args)
    return { tasks: (args[1] === 'default' ? [{ id: 'default-task' }] : [
      { id: 'default-task' }, { id: '1542a2fb-5509-4654-8c24-baed3dd0cc23' },
    ]) as Task[] }
  }
  try {
    await useTaskStore.getState().fetchTasks('project', 'default', true)
    await useTaskStore.getState().fetchTasks('project')
    assert.deepEqual(useTaskStore.getState().tasks.map(task => task.id), ['default-task'])
    assert.deepEqual(calls[1], ['project', 'default', true])
  } finally {
    taskApi.list = original
  }
})

test('a late response from the previous workflow cannot replace the current list', async () => {
  const original = taskApi.list
  let finishOld!: (value: { tasks: Task[] }) => void
  taskApi.list = async (_project, workflow) => workflow === 'simple'
    ? new Promise(resolve => { finishOld = resolve })
    : { tasks: [{ id: 'default-task' }] as Task[] }
  try {
    const oldRequest = useTaskStore.getState().fetchTasks('project', 'simple', false)
    await useTaskStore.getState().fetchTasks('project', 'default', false)
    finishOld({ tasks: [{ id: 'simple-task' }] as Task[] })
    await oldRequest
    assert.deepEqual(useTaskStore.getState().tasks.map(task => task.id), ['default-task'])
  } finally {
    taskApi.list = original
  }
})

test('board selection excludes other workflows loaded through task details', async () => {
  const original = taskApi.get
  useTaskStore.setState({ tasks: [{ id: 'default-task', workflow_id: 'default' }] as Task[] })
  taskApi.get = async () => ({ id: 'simple-task', workflow_id: 'simple' }) as Task
  try {
    await useTaskStore.getState().refreshTask('simple-task', 'project')
    const select = (taskStore as Record<string, any>).selectWorkflowTasks
    assert.equal(typeof select, 'function')
    assert.deepEqual(select(useTaskStore.getState().tasks, 'default', false).map((task: Task) => task.id), ['default-task'])
    assert.deepEqual(select(useTaskStore.getState().tasks, 'simple', false).map((task: Task) => task.id), ['simple-task'])
  } finally {
    taskApi.get = original
  }
})
