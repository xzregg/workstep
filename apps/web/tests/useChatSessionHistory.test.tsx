import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { chatSessionApi } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import { useChatSessionHistory } from '../src/hooks/useChatSessionHistory'
import { useChatSessionStore } from '../src/stores/chatSessionStore'

test('reconnect recovers missed conversation messages with no overlapping history requests', async () => {
  const { window } = installDomEnvironment()
  const originalGet = chatSessionApi.get
  let requests = 0
  let concurrent = 0
  let maxConcurrent = 0
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const messages = [
    { id: 'u', role: 'user', content: '问题', status: 'succeeded' },
    { id: 'm', role: 'assistant', content: '完整回复', status: 'succeeded' },
    { id: 'next', role: 'user', content: '后台收到的新消息', status: 'succeeded' },
  ]
  let missing = 0
  function Harness() {
    useChatSessionHistory({ sessionId: 's', projectId: 'p', onLoaded: () => {}, onMissing: () => { missing++ } })
    return null
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    useChatSessionStore.setState({ sessions: {} })
    chatSessionApi.get = (async () => {
      const request = ++requests
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      if (request === 2) await pending
      concurrent--
      return {
        id: 's', project_id: 'p', title: '渠道对话',
        running: request === 1,
        messages: request === 1 ? [messages[0], { ...messages[1], content: '旧片段', status: 'running' }] : messages,
      }
    }) as never
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    assert.equal(useChatSessionStore.getState().sessions.s.running, true)
    await act(async () => window.dispatchEvent(new window.Event('workstep:reconnected')))
    await act(async () => window.dispatchEvent(new window.Event('workstep:reconnected')))
    assert.equal(requests, 2)
    await act(async () => release())
    assert.equal(requests, 3)
    assert.equal(maxConcurrent, 1)
    assert.equal(missing, 0)
    const session = useChatSessionStore.getState().sessions.s
    assert.equal(session.running, false)
    assert.deepEqual(session.messages.map((message) => message.id), ['u', 'm', 'next'])
    assert.equal(session.messages[1].content, '完整回复')
  } finally {
    await act(async () => root.unmount())
    chatSessionApi.get = originalGet
    useChatSessionStore.setState({ sessions: {} })
    await window.happyDOM.close()
  }
})

test('session history loads once when a caller updates its catalog callback', async () => {
  const { window } = installDomEnvironment()
  const originalGet = chatSessionApi.get
  let requests = 0
  let root!: Root
  let updateCatalog!: () => void
  let loadedTitle = ''

  function Harness() {
    const [version, setVersion] = useState(0)
    updateCatalog = () => setVersion((current) => current + 1)
    useChatSessionHistory({
      sessionId: 'session-1', projectId: 'project-1',
      onLoaded: (detail) => { loadedTitle = `${detail.title}:${version}` },
      onMissing: () => {},
    })
    return null
  }

  try {
    chatSessionApi.get = (async (sessionId: string) => {
      requests += 1
      return {
        id: sessionId, project_id: 'project-1', workflow_id: null,
        title: '会话', engine: '', provider_id: '', model: '',
        fast_model: '', vision_model: '', permission_mode: '',
        message_count: 0, messages: [], running: false,
        created_at: '', updated_at: '',
      }
    }) as never
    useChatSessionStore.setState({ sessions: {} })
    const container = window.document.body.appendChild(window.document.createElement('div'))
    await act(async () => {
      root = createRoot(container as never)
      root.render(<I18nProvider><Harness /></I18nProvider>)
    })
    assert.equal(requests, 1)
    assert.equal(loadedTitle, '会话:0')
    await act(async () => { updateCatalog() })
    assert.equal(requests, 1)
    await act(async () => { root.unmount() })
  } finally {
    chatSessionApi.get = originalGet
    useChatSessionStore.setState({ sessions: {} })
    await window.happyDOM.close()
  }
})

test('event details follow the current session id after a send migrates it', async () => {
  const { window } = installDomEnvironment()
  const originalEvents = chatSessionApi.messageEvents
  const requests: string[] = []
  let root!: Root
  let history!: ReturnType<typeof useChatSessionHistory>

  function Harness() {
    history = useChatSessionHistory({
      sessionId: null,
      messageSessionId: 'migrated-session',
      projectId: 'project-1',
      onLoaded: () => {}, onMissing: () => {},
    })
    return null
  }

  try {
    chatSessionApi.messageEvents = (async (sessionId) => {
      requests.push(sessionId)
      return { events: [], complete: true, next_cursor: null }
    }) as never
    const store = useChatSessionStore.getState()
    store.newSession('migrated-session')
    store.hydrateSession('migrated-session', [{
      id: 'message-1', role: 'assistant', content: '', status: 'succeeded',
      event_detail: { available: true, loaded: false }, events: [],
    } as never], false)
    const container = window.document.body.appendChild(window.document.createElement('div'))
    await act(async () => {
      root = createRoot(container as never)
      root.render(<I18nProvider><Harness /></I18nProvider>)
    })
    await act(async () => { await history.loadMessageEvents('message-1') })
    assert.deepEqual(requests, ['migrated-session'])
    await act(async () => { root.unmount() })
  } finally {
    chatSessionApi.messageEvents = originalEvents
    useChatSessionStore.setState({ sessions: {} })
    await window.happyDOM.close()
  }
})


test('history loads latest 300, deduplicates older requests and stops at the end', async () => {
  const { window } = installDomEnvironment()
  const originalGet = chatSessionApi.get
  const requests: number[] = []
  let history!: ReturnType<typeof useChatSessionHistory>
  let beforePrepend = 0
  function Harness() {
    history = useChatSessionHistory({ sessionId: 'paged', projectId: 'p', onLoaded: () => {}, onMissing: () => {} })
    return null
  }
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')) as never)
  try {
    useChatSessionStore.setState({ sessions: {} })
    chatSessionApi.get = (async (id, project, limit, offset) => {
      assert.equal(limit, 300)
      requests.push(offset)
      return { id, running: false, messages: Array.from({ length: offset === 0 ? 300 : 2 }, (_, i) => ({
        id: String(offset === 0 ? i + 2 : i), role: 'user', content: '消息', status: 'succeeded',
      })) }
    }) as never
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    await act(async () => {
      await Promise.all([history.loadOlderHistory(() => beforePrepend++), history.loadOlderHistory()])
    })
    await act(async () => { await history.loadOlderHistory() })
    assert.deepEqual(requests, [0, 300])
    assert.equal(beforePrepend, 1)
    const messages = useChatSessionStore.getState().sessions.paged.messages
    assert.equal(messages.length, 302)
    assert.deepEqual(messages.slice(0, 3).map(m => m.id), ['0', '1', '2'])
  } finally {
    await act(async () => root.unmount())
    chatSessionApi.get = originalGet
    useChatSessionStore.setState({ sessions: {} })
    await window.happyDOM.close()
  }
})


test('403 retains selected session, exposes the error and permits retry; only 404 is missing', async () => {
 const { window } = installDomEnvironment()
 const original = chatSessionApi.get
 let missing = 0, status = 403
 let history!: ReturnType<typeof useChatSessionHistory>
 function Harness() {
  history = useChatSessionHistory({ sessionId: 's', projectId: 'p', onLoaded: () => {}, onMissing: () => missing++ })
  return null
 }
 const root = createRoot(document.body.appendChild(document.createElement('div')))
 try {
  chatSessionApi.get = (async () => { throw Object.assign(new Error('Project proxy scope unavailable'), { status }) }) as never
  await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
  assert.equal(missing, 0)
  assert.match(history.historyError, /403.*Project proxy scope unavailable/)
  status = 404
  await act(async () => history.retryHistory())
  assert.equal(missing, 1)
 } finally {
  await act(async () => root.unmount()); chatSessionApi.get = original
  useChatSessionStore.setState({ sessions: {} }); await window.happyDOM.close()
 }
})
