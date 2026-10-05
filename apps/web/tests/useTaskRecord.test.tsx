import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiError } from '../src/api/transport'
import { useTaskRecord } from '../src/hooks/useTaskRecord'
import { useTaskStore } from '../src/stores/taskStore'
import { installDomEnvironment } from './helpers/domEnv'

test('task detail keeps a fetched task when another workflow list replaces the board', async () => {
  const { window } = installDomEnvironment()
  const original = useTaskStore.getState()
  const task = { id: 'target', title: '目标任务' } as Awaited<ReturnType<typeof original.refreshTask>>
  const other = { id: 'other', title: '另一流程的任务' } as typeof task
  const requests: string[] = []
  useTaskStore.setState({ tasks: [], refreshTask: async (id, projectId) => {
    requests.push(`${projectId}:${id}`)
    return task
  } })
  let selected: ReturnType<typeof useTaskRecord>
  function Harness() { selected = useTaskRecord('target', 'project'); return null }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Harness />))
    assert.deepEqual(requests, ['project:target'])
    assert.equal(selected!.task?.id, 'target')
    await act(async () => useTaskStore.setState({ tasks: [other] }))
    assert.equal(selected!.task?.id, 'target')
  } finally {
    await act(async () => root.unmount())
    useTaskStore.setState({ tasks: original.tasks, refreshTask: original.refreshTask })
    container.remove()
    await window.happyDOM.close()
  }
})


test('task detail waits for its read and distinguishes network errors from missing tasks', async () => {
  const { window } = installDomEnvironment()
  const original = useTaskStore.getState()
  let rejectRead: (error: Error) => void = () => {}
  let attempts = 0
  useTaskStore.setState({ tasks: [], refreshTask: async () => {
    attempts++
    if (attempts === 1) return new Promise((_, reject) => { rejectRead = reject })
    if (attempts === 2) throw new ApiError('Task not found', 404)
    return { id: 'target', title: '目标任务' } as Awaited<ReturnType<typeof original.refreshTask>>
  } })
  let selected!: ReturnType<typeof useTaskRecord>
  function Harness() { selected = useTaskRecord('target', 'project'); return null }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<Harness />))
    assert.equal(selected.status, 'loading')
    await act(async () => rejectRead(new TypeError('Failed to fetch')))
    assert.equal(selected.status, 'error')
    assert.equal(selected.error, 'Failed to fetch')
    await act(async () => selected.retry())
    assert.equal(attempts, 2)
    assert.equal(selected.status, 'not-found')
    await act(async () => selected.retry())
    assert.equal(selected.status, 'ready')
    assert.equal(selected.task?.id, 'target')
  } finally {
    await act(async () => root.unmount())
    useTaskStore.setState({ tasks: original.tasks, refreshTask: original.refreshTask })
    await window.happyDOM.close()
  }
})
