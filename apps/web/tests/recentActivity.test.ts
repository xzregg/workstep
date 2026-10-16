import assert from 'node:assert/strict'
import test from 'node:test'
import { taskApi, type Task } from '../src/api/client'
import { recentActivityKey, useRecentActivityStore } from '../src/stores/recentActivityStore'

const target = { kind: 'task' as const, projectId: 'p', id: 't' }
const event = { type: 'CUSTOM', name: 'workstep.status', task_id: 't', project_id: 'p', value: { status: 'paused' } }
const settle = () => new Promise<void>(resolve => setImmediate(resolve))

test('recent task requests deduplicate and discard snapshots invalidated by a status event', async () => {
  const original = taskApi.get
  const reads: Array<(task: Task) => void> = []
  taskApi.get = () => new Promise(resolve => reads.push(resolve))
  const store = useRecentActivityStore.getState()
  try {
    store.setTargets([target])
    store.setTargets([{ ...target }])
    assert.equal(reads.length, 1)
    const refresh = store.handleWsEvent(event)
    reads[0]({ status: 'running' } as Task)
    await settle()
    assert.equal(reads.length, 2, 'an event during a read queues one fresh snapshot')
    assert.equal(useRecentActivityStore.getState().runningTasks[recentActivityKey(target)], undefined)
    reads[1]({ status: 'paused' } as Task)
    await refresh
    assert.equal(useRecentActivityStore.getState().runningTasks[recentActivityKey(target)], false)
    await store.handleWsEvent({ ...event, project_id: 'other' })
    await store.handleWsEvent({ ...event, type: 'TEXT_MESSAGE_CHUNK' })
    assert.equal(reads.length, 2, 'other projects and message chunks do not refresh status')
  } finally { store.setTargets([]); taskApi.get = original }
})

test('removed or reauthenticated targets ignore late reads and failed reads clear running state', async () => {
  const original = taskApi.get
  let resolveOld!: (task: Task) => void
  taskApi.get = () => new Promise(resolve => { resolveOld = resolve })
  const store = useRecentActivityStore.getState()
  try {
    store.setTargets([target])
    store.setTargets([])
    taskApi.get = async () => ({ status: 'running' } as Task)
    store.setTargets([{ ...target }])
    await settle()
    assert.equal(useRecentActivityStore.getState().runningTasks[recentActivityKey(target)], true)
    resolveOld({ status: 'stopped' } as Task)
    await settle()
    assert.equal(useRecentActivityStore.getState().runningTasks[recentActivityKey(target)], true)
    taskApi.get = async () => { throw new Error('not readable') }
    await store.refreshTasks()
    assert.equal(useRecentActivityStore.getState().runningTasks[recentActivityKey(target)], false)
    store.setTargets([])
    assert.deepEqual(useRecentActivityStore.getState().runningTasks, {})
  } finally { store.setTargets([]); taskApi.get = original }
})


test('recent tasks track unread outcomes, acknowledge opens, and reset for a new run', async () => {
  const original = taskApi.get
  let task = { status: 'running', steps: [] } as unknown as Task
  taskApi.get = async () => task
  const store = useRecentActivityStore.getState()
  const key = recentActivityKey(target)
  try {
    store.setTargets([target])
    await settle()
    task = { status: 'ready', steps: [{ status: 'passed' }] } as Task
    await store.refreshTasks()
    assert.equal(useRecentActivityStore.getState().completedTasks[key], true)
    store.markTaskRead(target)
    assert.equal(useRecentActivityStore.getState().completedTasks[key], undefined)
    task = { status: 'running', steps: [] } as unknown as Task
    await store.refreshTasks()
    task = { status: 'stopped', steps: [{ status: 'failed' }] } as Task
    await store.refreshTasks()
    assert.equal(useRecentActivityStore.getState().failedTasks[key], true)
    store.markTaskRead(target)
    await store.refreshTasks()
    assert.equal(useRecentActivityStore.getState().failedTasks[key], false)
    taskApi.get = async () => { throw new Error('unreadable') }
    await store.refreshTasks()
    assert.equal(useRecentActivityStore.getState().completedTasks[key], undefined)
    assert.equal(useRecentActivityStore.getState().failedTasks[key], false)
    store.setTargets([])
    assert.deepEqual(useRecentActivityStore.getState().failedTasks, {})
  } finally { store.setTargets([]); taskApi.get = original }
})
