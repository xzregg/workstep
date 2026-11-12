import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import { useUserSettingsStore } from '../src/stores/userSettingsStore'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { chatSessionApi } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import { useChatSessionHistory } from '../src/hooks/useChatSessionHistory'
import { useChatSessionStore } from '../src/stores/chatSessionStore'
import ProcessTrace from '../src/components/ProcessTrace'

for (const running of [true, false]) test(`summary-only messages load the collapsed preview automatically only while running=${running}`, async () => {
  const { window } = installDomEnvironment()
  const originalGet = chatSessionApi.get, originalEvents = chatSessionApi.messageEvents
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  let detailRequests = 0
  function Harness() {
    const history = useChatSessionHistory({ sessionId: 'preview-session', projectId: 'p', onLoaded() {}, onMissing() {} })
    const message = useChatSessionStore(state => state.sessions['preview-session']?.messages[0])
    return message ? <ProcessTrace events={message.events || []} running={message.status === 'running'}
      eventSummary={message.event_summary} detailsAvailable={message.event_detail?.available}
      detailsLoaded={message.event_detail?.loaded} detailsLoading={message.event_detail?.loading}
      detailsError={message.event_detail?.error} onLoadDetails={() => void history.loadMessageEvents(message.id)} /> : null
  }
  try {
    useChatSessionStore.setState({ sessions: {} })
    chatSessionApi.get = (async () => ({ id: 'preview-session', project_id: 'p', running, messages: [{
      id: 'preview-message', role: 'assistant', content: '', status: running ? 'running' : 'succeeded',
      events: [], event_summary: { tool_count: 2, commentary_characters: 10 },
      event_detail: { available: true, loaded: false },
    }] })) as never
    chatSessionApi.messageEvents = (async () => {
      detailRequests++
      return { events: [
        { type: 'TOOL_CALL_START', toolCallId: 'a', toolCallName: '读取文件' },
        { type: 'TEXT_MESSAGE_CHUNK', phase: 'commentary', delta: '继续检查' },
        { type: 'TOOL_CALL_START', toolCallId: 'b', toolCallName: '检查结果' },
      ], complete: true, next_cursor: null }
    }) as never
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    assert.equal(detailRequests, running ? 1 : 0)
    assert.equal(document.querySelector('.process-trace-session-summary')!.getAttribute('aria-expanded'), 'false')
    assert.equal(document.querySelectorAll('.process-trace-preview-item').length, running ? 2 : 0)
    if (running) {
      assert.match(document.querySelector('.process-trace-preview')!.textContent!, /继续检查.*检查结果/)
      await act(async () => document.querySelector<HTMLElement>('.process-trace-session-summary')!.click())
      assert.equal(document.querySelector('.process-trace-body')!.children.length, 3)
      await act(async () => useChatSessionStore.getState().handleWsEvent({
        type: 'TEXT_MESSAGE_CHUNK', channel: 'session_chat', session_id: 'preview-session',
        messageId: 'preview-message', phase: 'commentary', delta: '新的实时进度',
      }))
      assert.match(document.querySelector('.process-trace-body')!.textContent!, /新的实时进度/)
      await act(async () => document.querySelector<HTMLElement>('.process-trace-session-summary')!.click())
      assert.equal(document.querySelectorAll('.process-trace-preview-item').length, 2)
      assert.match(document.querySelector('.process-trace-preview')!.textContent!, /新的实时进度/)
      assert.equal(detailRequests, 1, 'expanding reuses the in-flight or loaded event details')
    }
  } finally {
    await act(async () => root.unmount())
    chatSessionApi.get = originalGet; chatSessionApi.messageEvents = originalEvents
    useChatSessionStore.setState({ sessions: {} })
    await window.happyDOM.close()
  }
})

test('reconnect history summaries preserve the event details already opened by the user', async () => {
  const { window } = installDomEnvironment()
  const originalGet = chatSessionApi.get
  const originalEvents = chatSessionApi.messageEvents
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const events = [{ type: 'thinking_delta', data: { delta: '已加载的完整事件详情' } }]
  let historyRequests = 0
  function Harness() {
    const history = useChatSessionHistory({ sessionId: 'detail-session', projectId: 'p', onLoaded() {}, onMissing() {} })
    const message = useChatSessionStore(state => state.sessions['detail-session']?.messages[0])
    return message ? <ProcessTrace events={message.events || []} running={message.status === 'running'}
      detailsAvailable={message.event_detail?.available} detailsLoaded={message.event_detail?.loaded}
      detailsLoading={message.event_detail?.loading} onLoadDetails={() => void history.loadMessageEvents(message.id)} /> : null
  }
  try {
    useChatSessionStore.setState({ sessions: {} })
    chatSessionApi.get = (async () => {
      historyRequests++
      return { id: 'detail-session', project_id: 'p', running: false, messages: [{
        id: 'detail-message', role: 'assistant', content: historyRequests === 1 ? '回复' : '后台补齐的回复', status: 'succeeded',
        events: [], event_detail: { available: true, loaded: false },
      }] }
    }) as never
    chatSessionApi.messageEvents = (async () => ({ events, complete: true, next_cursor: null })) as never
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    await act(async () => document.querySelector<HTMLElement>('.process-trace-session-summary')!.click())
    assert.match(document.querySelector('.process-trace-body')!.textContent!, /已加载的完整事件详情/)
    await act(async () => window.dispatchEvent(new window.Event('workstep:reconnected')))
    assert.equal(historyRequests, 2)
    assert.equal(useChatSessionStore.getState().sessions['detail-session'].messages[0].content, '后台补齐的回复',
      'preserving details must not suppress normal history recovery')
    assert.equal(document.querySelector('.process-trace-session-summary')!.getAttribute('aria-expanded'), 'true')
    assert.match(document.querySelector('.process-trace-body')!.textContent!, /已加载的完整事件详情/,
      'background summary refresh must not erase expanded details')
  } finally {
    await act(async () => root.unmount())
    chatSessionApi.get = originalGet
    chatSessionApi.messageEvents = originalEvents
    useChatSessionStore.setState({ sessions: {} })
    await window.happyDOM.close()
  }
})

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
    useUserSettingsStore.setState({ messageHistoryPageSize: 20 })
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
    useUserSettingsStore.setState({ messageHistoryPageSize: 20 })
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


for (const [width, pageSize] of [[390, 20], [1023, 20], [1280, 20], [1280, 40]]) {
test(`history at width ${width} loads latest ${pageSize}, deduplicates older requests and stops at the end`, async () => {
  const { window } = installDomEnvironment()
  const originalGet = chatSessionApi.get
  window.happyDOM.setWindowSize({ width })
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
    useUserSettingsStore.setState({ loaded: true, loading: false, messageHistoryPageSize: pageSize })
    chatSessionApi.get = (async (id, project, limit, offset) => {
      assert.equal(limit, pageSize)
      requests.push(offset)
      return { id, running: false, messages: Array.from({ length: offset === 0 ? pageSize : 2 }, (_, i) => ({
        id: String(offset === 0 ? i + 2 : i), role: 'user', content: '消息', status: 'succeeded',
      })) }
    }) as never
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    await act(async () => {
      await Promise.all([history.loadOlderHistory(() => beforePrepend++), history.loadOlderHistory()])
    })
    await act(async () => { await history.loadOlderHistory() })
    assert.deepEqual(requests, [0, pageSize])
    assert.equal(beforePrepend, 1)
    await act(async () => useUserSettingsStore.setState({ messageHistoryPageSize: 10 }))
    assert.deepEqual(requests, [0, pageSize], 'saving a size must not reload the open session')
    const messages = useChatSessionStore.getState().sessions.paged.messages
    assert.equal(messages.length, pageSize + 2)
    assert.deepEqual(messages.slice(0, 3).map(m => m.id), ['0', '1', '2'])
  } finally {
    await act(async () => root.unmount())
    chatSessionApi.get = originalGet
    useUserSettingsStore.setState({ messageHistoryPageSize: 20 })
    useChatSessionStore.setState({ sessions: {} })
    await window.happyDOM.close()
  }
})
}


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
