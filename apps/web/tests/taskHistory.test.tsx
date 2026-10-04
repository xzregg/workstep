import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useRef, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { taskApi } from '../src/api/client'
import { useTaskHistory } from '../src/hooks/useTaskHistory'

test('task history loads once, pages older messages, and coalesces refresh signals', async () => {
  const { window } = installDomEnvironment()
  const original = taskApi.history
  const requests: number[] = []
  taskApi.history = async (_taskId, _projectId, _limit, offset) => {
    requests.push(offset ?? 0)
    return { messages: offset ? [{ id: 'older' }]
      : Array.from({ length: 300 }, (_, index) => ({ id: index === 0 ? 'latest' : `message-${index}` }))
    } as Awaited<ReturnType<typeof taskApi.history>>
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let current: ReturnType<typeof useTaskHistory> | undefined
  function Harness({ remote, review }: { remote: number; review: string }): ReactNode {
    const scrollRef = useRef<HTMLDivElement>(null)
    const followRef = useRef(true)
    const programmaticTopRef = useRef(0)
    current = useTaskHistory({ taskId: 'task', projectId: 'project',
      userMessageEvents: remote, reviewEventSignal: review,
      chatScrollRef: scrollRef, shouldFollowMessagesRef: followRef,
      lastProgrammaticScrollTopRef: programmaticTopRef })
    return <div ref={scrollRef}>{current.historyMessages.map(message => <span key={message.id}>{message.id}</span>)}</div>
  }
  try {
    await act(async () => root.render(<Harness remote={1} review="existing" />))
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 80)) })
    assert.deepEqual(requests, [0])
    assert.match(container.textContent!, /latest/)
    await act(async () => current!.loadOlderHistory())
    assert.deepEqual(requests, [0, 300])
    assert.match(container.textContent!, /older/)
    await act(async () => root.render(<Harness remote={2} review="changed" />))
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 80)) })
    assert.deepEqual(requests, [0, 300, 0])
  } finally {
    taskApi.history = original
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
