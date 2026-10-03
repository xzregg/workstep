import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useWebSocket } from '../src/hooks/useWebSocket'
import { useProjectStore } from '../src/stores/projectStore'
import { useTaskStore } from '../src/stores/taskStore'
import { useChatListStore, useChatSessionStore } from '../src/stores/chatSessionStore'

class Socket {
  static OPEN = 1
  static CONNECTING = 0
  static instances: Socket[] = []
  readyState = 0
  sent: Record<string, unknown>[] = []
  onopen?: () => void
  onclose?: () => void
  onmessage?: (event: { data: string }) => void
  onerror?: () => void
  constructor(_url: string) { Socket.instances.push(this) }
  send(value: string) { this.sent.push(JSON.parse(value)) }
  close() { this.readyState = 3; this.onclose?.() }
  open() { this.readyState = 1; this.onopen?.() }
  receive(value: object) { this.onmessage?.({ data: JSON.stringify(value) }) }
}

test('foreground recovery replaces stale sockets, restores subscriptions and refreshes data', async (context) => {
  const { window } = installDomEnvironment()
  const originalSocket = globalThis.WebSocket
  const originalTasks = useTaskStore.getState().fetchTasks
  const originalRefresh = useChatListStore.getState().refreshSessions
  const originalProject = useProjectStore.getState().activeProject
  let refreshes = 0
  let recoveries = 0
  const recovered = () => recoveries++
  window.addEventListener('workstep:reconnected', recovered)
  globalThis.WebSocket = Socket as never
  Socket.instances = []
  useProjectStore.setState({ activeProject: { id: 'p' } as never })
  useTaskStore.setState({ fetchTasks: async () => {} })
  useChatListStore.setState({ refreshSessions: () => { refreshes++ } })
  useChatSessionStore.setState({ sessions: {} })
  useChatSessionStore.getState().newSession('channel-chat')
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  function Harness() { useWebSocket(); return null }
  try {
    await act(async () => root.render(<Harness />))
    const first = Socket.instances[0]
    await act(async () => first.open())
    assert.equal(refreshes, 0)
    await act(async () => {
      window.dispatchEvent(new window.Event('workstep:resume'))
      context.mock.timers.tick(1)
    })
    assert.equal(first.readyState, 3)
    assert.equal(Socket.instances.length, 2)
    const second = Socket.instances[1]
    await act(async () => second.open())
    assert.ok((second.sent[0].session_ids as string[]).includes('channel-chat'))
    assert.equal(refreshes, 1)
    assert.equal(recoveries, 1)
    await act(async () => {
      second.receive({ type: 'TEXT_MESSAGE_CHUNK', channel: 'session_chat', session_id: 'channel-chat', messageId: 'm', delta: '实时正文' })
      first.onclose?.() // A delayed callback from the old socket must not reconnect again.
      context.mock.timers.tick(1000)
    })
    assert.equal(Socket.instances.length, 2)
    assert.equal(useChatSessionStore.getState().sessions['channel-chat'].messages[0].content, '实时正文')
    await act(async () => context.mock.timers.tick(20000))
    const ping = second.sent.find((frame) => frame.type === 'ping')
    assert.ok(ping)
    await act(async () => second.receive({ type: 'pong', nonce: ping.nonce }))
    await act(async () => context.mock.timers.tick(10000))
    assert.equal(Socket.instances.length, 2)
    await act(async () => context.mock.timers.tick(10000))
    await act(async () => context.mock.timers.tick(10000))
    assert.equal(Socket.instances.length, 3, 'missing heartbeat reply replaces a half-open connection')
    await act(async () => Socket.instances[2].open())
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => {
      document.dispatchEvent(new window.Event('visibilitychange'))
      context.mock.timers.tick(1)
    })
    assert.equal(Socket.instances.length, 3)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    await act(async () => {
      document.dispatchEvent(new window.Event('visibilitychange'))
      window.dispatchEvent(new window.Event('online'))
      context.mock.timers.tick(1)
    })
    assert.equal(Socket.instances.length, 4, 'foreground and network notifications coalesce')
  } finally {
    await act(async () => root.unmount())
    context.mock.timers.reset()
    globalThis.WebSocket = originalSocket
    useTaskStore.setState({ fetchTasks: originalTasks })
    useChatListStore.setState({ refreshSessions: originalRefresh })
    useProjectStore.setState({ activeProject: originalProject })
    useChatSessionStore.setState({ sessions: {} })
    window.removeEventListener('workstep:reconnected', recovered)
    await window.happyDOM.close()
  }
})
