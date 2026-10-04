import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { taskApi } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import { useTaskPendingInserts } from '../src/hooks/useTaskPendingInserts'
import { usePendingMessageInsertStore } from '../src/stores/pendingMessageInsertStore'

const key = 'project-1:target-1'
const item = { id: 'insert-1', content: ' queued message ' }

test('step insert send updates optimistic history and removes only accepted queue items', async () => {
  const { window } = installDomEnvironment()
  const originalSend = taskApi.sendStepMessage
  const originalRemove = usePendingMessageInsertStore.getState().remove
  const removed: string[] = []
  taskApi.sendStepMessage = async () => ({ message_id: 'sent-1', channel: 'execution',
    sequence: 2, created_at: '2026-09-25T00:00:00Z' }) as Awaited<ReturnType<typeof taskApi.sendStepMessage>>
  usePendingMessageInsertStore.setState({ queues: { [key]: [item] }, loaded: { [key]: true },
    remove: async (_project, _target, id) => { removed.push(id) } })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let inserts!: ReturnType<typeof useTaskPendingInserts>
  let history: any[] = []
  function Harness() {
    const [messages, setMessages] = useState<any[]>([])
    history = messages
    inserts = useTaskPendingInserts({ taskId: 'task-1', projectId: 'project-1',
      targetMessageId: 'target-1', channel: 'step', targetStepKey: 'build',
      activeStepKey: 'build', stepRunning: true, setHistoryMessages: setMessages,
      onCoordinatorRunning: () => {}, onCoordinatorAccepted: () => {},
      onFollow: () => {}, onError: (message) => { throw new Error(message) } })
    return <div />
  }
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    await act(async () => inserts.send([item]))
    assert.deepEqual(removed, ['insert-1'])
    assert.equal(history.length, 1)
    assert.equal(history[0].id, 'sent-1')
    assert.equal(history[0].content, 'queued message')
    assert.deepEqual(inserts.sendingIds, [])
  } finally {
    await act(async () => root.unmount())
    taskApi.sendStepMessage = originalSend
    usePendingMessageInsertStore.setState({ remove: originalRemove, queues: {}, loaded: {} })
    container.remove()
    await window.happyDOM.close()
  }
})

test('coordinator insert failure keeps its queue and rolls back optimistic history', async () => {
  const { window } = installDomEnvironment()
  const originalChat = taskApi.chat
  taskApi.chat = async () => { throw new Error('send failed') }
  usePendingMessageInsertStore.setState({ queues: { [key]: [item] }, loaded: { [key]: true } })
  const errors: string[] = []
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let inserts!: ReturnType<typeof useTaskPendingInserts>
  let history: any[] = []
  function Harness() {
    const [messages, setMessages] = useState<any[]>([])
    history = messages
    inserts = useTaskPendingInserts({ taskId: 'task-1', projectId: 'project-1',
      targetMessageId: 'target-1', channel: 'coordinator', targetStepKey: null,
      activeStepKey: 'build', stepRunning: false, setHistoryMessages: setMessages,
      onCoordinatorRunning: () => {}, onCoordinatorAccepted: () => {},
      onFollow: () => {}, onError: (message) => errors.push(message) })
    return <div />
  }
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    await act(async () => inserts.send([item]))
    assert.deepEqual(errors, ['send failed'])
    assert.equal(history.length, 0)
    assert.deepEqual(inserts.items.map((entry) => entry.id), ['insert-1'])
    assert.deepEqual(inserts.sendingIds, [])
  } finally {
    await act(async () => root.unmount())
    taskApi.chat = originalChat
    usePendingMessageInsertStore.setState({ queues: {}, loaded: {} })
    container.remove()
    await window.happyDOM.close()
  }
})
