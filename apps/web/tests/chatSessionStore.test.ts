import assert from 'node:assert/strict'
import test from 'node:test'

import {
  mergeChatSessionRunningState,
  useChatListStore,
  useChatSessionStore,
} from '../src/stores/chatSessionStore.ts'
import { zhCN } from '../src/i18n/locales/zh-CN.ts'

function summary(id: string, title: string, messageCount = 0) {
  return {
    id,
    project_id: 'p1',
    workflow_id: 'wf-1',
    title,
    engine: 'claude',
    model: null,
    message_count: messageCount,
    created_at: '2026-08-12T00:00:00+00:00',
    updated_at: '2026-08-12T00:00:00+00:00',
  }
}

test('sidebar running state falls back to persisted list state until a live event arrives', () => {
  const running = { ...summary('s1', '执行中'), running: true }
  assert.deepEqual(mergeChatSessionRunningState([running], {}), { s1: true })
  assert.deepEqual(mergeChatSessionRunningState([running], { s1: false }), { s1: false })
  assert.deepEqual(mergeChatSessionRunningState([running], { s2: true }), { s1: true, s2: true })
})

test('chat message store only accepts session_chat events', () => {
  useChatSessionStore.setState({ sessions: {} })
  useChatSessionStore.getState().newSession('chat-1')
  useChatSessionStore.getState().handleWsEvent({
    type: 'TEXT_MESSAGE_START',
    channel: 'flow_gen',
    session_id: 'chat-1',
    messageId: 'm-1',
  })
  // Wrong channel: nothing is created.
  assert.equal(useChatSessionStore.getState().sessions['chat-1'].messages.length, 0)

  useChatSessionStore.getState().handleWsEvent({
    type: 'TEXT_MESSAGE_START',
    channel: 'session_chat',
    session_id: 'chat-1',
    messageId: 'm-1',
  })
  useChatSessionStore.getState().handleWsEvent({
    type: 'TEXT_MESSAGE_CHUNK',
    channel: 'session_chat',
    session_id: 'chat-1',
    messageId: 'm-1',
    delta: '你好',
  })
  useChatSessionStore.getState().handleWsEvent({
    type: 'TEXT_MESSAGE_END',
    channel: 'session_chat',
    session_id: 'chat-1',
    messageId: 'm-1',
    status: 'succeeded',
    content: '你好',
  })

  const session = useChatSessionStore.getState().sessions['chat-1']
  assert.equal(session.messages.length, 1)
  assert.equal(session.messages[0].content, '你好')
  assert.equal(session.messages[0].status, 'succeeded')
})

test('chat session stays running when history or a stream chunk contains a running assistant message', () => {
  useChatSessionStore.setState({ sessions: {} })
  const store = useChatSessionStore.getState()

  store.hydrateSession('chat-history-running', [{
    id: 'm-history',
    role: 'assistant',
    content: '仍在处理',
    status: 'running',
  }])
  assert.equal(
    useChatSessionStore.getState().sessions['chat-history-running'].running,
    true,
  )

  store.newSession('chat-chunk-running')
  store.handleWsEvent({
    type: 'TEXT_MESSAGE_CHUNK',
    channel: 'session_chat',
    session_id: 'chat-chunk-running',
    messageId: 'm-chunk',
    delta: '流式回复',
  })
  assert.equal(
    useChatSessionStore.getState().sessions['chat-chunk-running'].running,
    true,
  )
})

test('chat list store tracks the project session list', () => {
  useChatListStore.setState({ sessionsByProject: {}, listLoadingByProject: {} })
  const store = useChatListStore.getState()

  store.addSession(summary('s1', '第一个会话'))
  store.addSession(summary('s2', '第二个会话'))
  store.addSession(summary('s3', '第三个会话'))

  assert.deepEqual(
    useChatListStore.getState().sessionsByProject.p1.map((s) => s.id),
    ['s3', 's2', 's1'],
  )

  store.renameSession('s1', '改名了')
  assert.equal(
    useChatListStore.getState().sessionsByProject.p1.find((s) => s.id === 's1')?.title,
    '改名了',
  )

  store.removeSession('s1')
  assert.deepEqual(
    useChatListStore.getState().sessionsByProject.p1.map((s) => s.id),
    ['s3', 's2'],
  )
})

test('chat list store keeps sessions separated by project', () => {
  useChatListStore.setState({ sessionsByProject: {}, listLoadingByProject: {} })
  const store = useChatListStore.getState()

  store.addSession({ ...summary('p1-s1', '项目一'), project_id: 'p1' })
  store.addSession({ ...summary('p2-s1', '项目二'), project_id: 'p2' })

  assert.deepEqual(
    useChatListStore.getState().sessionsByProject.p1.map((session) => session.id),
    ['p1-s1'],
  )
  assert.deepEqual(
    useChatListStore.getState().sessionsByProject.p2.map((session) => session.id),
    ['p2-s1'],
  )

  store.renameSession('p1-s1', '项目一改名')
  assert.equal(useChatListStore.getState().sessionsByProject.p1[0].title, '项目一改名')
  assert.equal(useChatListStore.getState().sessionsByProject.p2[0].title, '项目二')
})

test('chat list selection is scoped to a single project', () => {
  useChatListStore.setState({
    sessionsByProject: {
      p1: [{ ...summary('p1-s1', '项目一'), project_id: 'p1' }],
      p2: [{ ...summary('p2-s1', '项目二'), project_id: 'p2' }],
    },
    selectedIds: new Set(),
    selectionProjectId: null,
    selectAnchor: null,
  })
  const store = useChatListStore.getState()

  store.handleSelect('p1-s1', {}, 'p1')
  assert.deepEqual([...useChatListStore.getState().selectedIds], ['p1-s1'])
  assert.equal(useChatListStore.getState().selectionProjectId, 'p1')

  store.handleSelect('p2-s1', { meta: true }, 'p2')
  assert.deepEqual([...useChatListStore.getState().selectedIds], ['p2-s1'])
  assert.equal(useChatListStore.getState().selectionProjectId, 'p2')
})

test('chat list store fetches projects concurrently without overwriting each other', async () => {
  useChatListStore.setState({ sessionsByProject: {}, listLoadingByProject: {} })
  const originalFetch = globalThis.fetch
  const resolvers: Record<string, (value: Response) => void> = {}
  globalThis.fetch = (input) => {
    const url = String(input)
    const projectId = url.includes('project_id=p1') ? 'p1' : 'p2'
    return new Promise<Response>((resolve) => { resolvers[projectId] = resolve })
  }
  try {
    const p1 = useChatListStore.getState().fetchSessions('p1')
    const p2 = useChatListStore.getState().fetchSessions('p2')
    resolvers.p2(new Response(JSON.stringify({ sessions: [{ ...summary('p2-s1', '项目二'), project_id: 'p2' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    resolvers.p1(new Response(JSON.stringify({ sessions: [{ ...summary('p1-s1', '项目一'), project_id: 'p1' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await Promise.all([p1, p2])

    assert.deepEqual(useChatListStore.getState().sessionsByProject.p1.map((session) => session.id), ['p1-s1'])
    assert.deepEqual(useChatListStore.getState().sessionsByProject.p2.map((session) => session.id), ['p2-s1'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('channel refresh received during a list request fetches the latest session list', async () => {
  useChatListStore.setState({ sessionsByProject: {}, listLoadingByProject: {} })
  const originalFetch = globalThis.fetch
  let resolveFirst: (value: Response) => void = () => {}
  let calls = 0
  globalThis.fetch = () => {
    calls++
    if (calls === 1) return new Promise<Response>((resolve) => { resolveFirst = resolve })
    return Promise.resolve(new Response(JSON.stringify({ sessions: [
      { ...summary('channel-1', '渠道对话', 2), source: 'channel' },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  try {
    const first = useChatListStore.getState().fetchSessions('p1')
    useChatListStore.getState().refreshSessions('p1')
    resolveFirst(new Response(JSON.stringify({ sessions: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    await first
    for (let i = 0; i < 10 && useChatListStore.getState().listLoadingByProject.p1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    assert.equal(calls, 2)
    assert.equal(useChatListStore.getState().sessionsByProject.p1[0].id, 'channel-1')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('channel refresh preserves sidebar selection', async () => {
  useChatListStore.setState({
    sessionsByProject: { p1: [summary('s1', '已选会话')] },
    listLoadingByProject: {},
    selectedIds: new Set(['s1']),
    selectionProjectId: 'p1',
    selectAnchor: 's1',
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ sessions: [summary('s1', '已选会话')] }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
  try {
    useChatListStore.getState().refreshSessions('p1')
    for (let i = 0; i < 10 && useChatListStore.getState().listLoadingByProject.p1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    assert.deepEqual([...useChatListStore.getState().selectedIds], ['s1'])
    assert.equal(useChatListStore.getState().selectAnchor, 's1')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('chat list store reorders sessions optimistically and persists', async () => {
  useChatListStore.setState({ sessionsByProject: {}, listLoadingByProject: {} })
  useChatListStore.getState().addSession(summary('s1', '一'))
  useChatListStore.getState().addSession(summary('s2', '二'))
  useChatListStore.getState().addSession(summary('s3', '三'))

  let sentBody: string | null = null
  let sentUrl = ''
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    sentUrl = String(input)
    sentBody = String(init?.body || '')
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    await useChatListStore.getState().reorderSessions('p1', ['s3', 's1', 's2'])
    assert.deepEqual(
      useChatListStore.getState().sessionsByProject.p1.map((s) => s.id),
      ['s3', 's1', 's2'],
    )
    assert.match(sentUrl, /chat-sessions\/reorder/)
    assert.ok(sentBody?.includes('"ordered_ids"'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('chat quick buttons save through the API and update locally', async () => {
  useChatListStore.setState({ quickButtons: [] })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    JSON.stringify({
      buttons: [
        { id: 'b1', label: '解释', prompt: '请解释' },
        { id: 'b2', label: '写测试', prompt: '请设计测试' },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
  try {
    const saved = await useChatListStore.getState().saveQuickButtons('p1', [
      { id: 'b1', label: '解释', prompt: '请解释' },
      { id: 'b2', label: '写测试', prompt: '请设计测试' },
    ])
    assert.equal(saved.length, 2)
    assert.deepEqual(
      useChatListStore.getState().quickButtons.map((b) => b.label),
      ['解释', '写测试'],
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('chat session copy keys exist in the zh-CN dictionary', () => {
  assert.equal(zhCN.chatSession.generateFailed, '生成失败')
  assert.equal(zhCN.chatSession.newSession, '新建对话')
  assert.equal(zhCN.chatSession.manageQuickButtons, '管理快捷按钮')
  assert.equal(zhCN.chatSession.manageSystemPrompt, '系统提示词')
  assert.equal(zhCN.chatSession.systemPromptHint.length > 0, true)
})
