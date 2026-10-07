import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useRef, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { taskApi } from '../src/api/client'
import { useTaskHistory } from '../src/hooks/useTaskHistory'
import { buildTaskConversationTimeline } from '../src/components/taskConversationFeed'

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

test('reconnect recovers a missed live-insert split without reloading the task page', async () => {
  const { window } = installDomEnvironment()
  const original = taskApi.history
  const before = [
    { id: 'before', channel: 'execution', role: 'assistant', sequence: 1, run_status: 'running',
      step_key: 'backend', content: '插入前的回复', created_at: '2026-10-07T06:11:42Z' },
    { id: 'insert', channel: 'execution', role: 'user', sequence: 2, run_status: 'running',
      step_key: 'backend', content: '不要改枚举', created_at: '2026-10-07T06:14:03Z' },
  ]
  let requests = 0
  taskApi.history = async () => ({ messages: ++requests === 1 ? before : [
    { ...before[0], run_status: 'succeeded' }, { ...before[1], run_status: 'succeeded' },
    { id: 'after', channel: 'execution', role: 'assistant', sequence: 3, run_status: 'running',
      step_key: 'backend', created_at: '2026-10-07T06:14:04Z' },
  ] }) as Awaited<ReturnType<typeof taskApi.history>>
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  function Harness() {
    const history = useTaskHistory({ taskId: 'task', projectId: 'project', userMessageEvents: 0,
      reviewEventSignal: '', chatScrollRef: useRef(null), shouldFollowMessagesRef: useRef(true),
      lastProgrammaticScrollTopRef: useRef(0) })
    const timeline = buildTaskConversationTimeline({ historyMessages: history.historyMessages,
      // Old live state remains running because END/START were lost during disconnect.
      liveMessages: { before: { ...before[0], status: 'running', content: '', events: [], proposals: [] } } as any,
      actionRuns: [], coordinatorRunning: false, actionTitle: (title) => title })
    return <div>{timeline.orderedMessages.map((message) => (
      <span key={message.id}>{message.id}:{message.run_status};</span>
    ))}</div>
  }
  try {
    await act(async () => root.render(<Harness />))
    assert.equal(container.textContent, 'before:running;insert:running;')
    await act(async () => {
      window.dispatchEvent(new window.Event('workstep:reconnected'))
      await new Promise(resolve => window.setTimeout(resolve, 80))
    })
    assert.equal(container.textContent, 'before:succeeded;insert:succeeded;after:running;')
    assert.equal(requests, 2)
  } finally {
    taskApi.history = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('recovery and message refresh wait for the initial history request and coalesce', async () => {
  const { window } = installDomEnvironment()
  const original = taskApi.history
  let requests = 0
  let finish!: (value: Awaited<ReturnType<typeof taskApi.history>>) => void
  taskApi.history = async () => {
    if (++requests === 1) return new Promise(resolve => { finish = resolve })
    return { messages: [{ id: 'latest', sequence: 1 }] } as Awaited<ReturnType<typeof taskApi.history>>
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  function Harness({ user }: { user: number }) {
    const history = useTaskHistory({ taskId: 'task', projectId: 'project', userMessageEvents: user,
      reviewEventSignal: '', chatScrollRef: useRef(null), shouldFollowMessagesRef: useRef(true),
      lastProgrammaticScrollTopRef: useRef(0) })
    return <div>{history.historyMessages.map(message => message.id).join(',')}</div>
  }
  try {
    await act(async () => root.render(<Harness user={0} />))
    await act(async () => {
      root.render(<Harness user={1} />)
      window.dispatchEvent(new window.Event('workstep:reconnected'))
      window.dispatchEvent(new window.Event('workstep:reconnected'))
    })
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 80)) })
    assert.equal(requests, 1)
    await act(async () => {
      finish({ messages: [] } as Awaited<ReturnType<typeof taskApi.history>>)
      await new Promise(resolve => window.setTimeout(resolve, 80))
    })
    assert.equal(requests, 2)
    assert.equal(container.textContent, 'latest')
    await act(async () => root.unmount())
    window.dispatchEvent(new window.Event('workstep:reconnected'))
    await new Promise(resolve => window.setTimeout(resolve, 80))
    assert.equal(requests, 2)
  } finally {
    taskApi.history = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
