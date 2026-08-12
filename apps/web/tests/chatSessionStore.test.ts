import assert from 'node:assert/strict'
import test from 'node:test'

import {
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

test('chat message store only accepts session_chat events', () => {
  useChatSessionStore.setState({ sessions: {} })
  useChatSessionStore.getState().newSession('chat-1')
  useChatSessionStore.getState().handleWsEvent({
    type: 'message_started',
    channel: 'flow_gen',
    session_id: 'chat-1',
    message_id: 'm-1',
    data: {},
  })
  // Wrong channel: nothing is created.
  assert.equal(useChatSessionStore.getState().sessions['chat-1'].messages.length, 0)

  useChatSessionStore.getState().handleWsEvent({
    type: 'message_started',
    channel: 'session_chat',
    session_id: 'chat-1',
    message_id: 'm-1',
    data: {},
  })
  useChatSessionStore.getState().handleWsEvent({
    type: 'text_delta',
    channel: 'session_chat',
    session_id: 'chat-1',
    message_id: 'm-1',
    data: { delta: '你好' },
  })
  useChatSessionStore.getState().handleWsEvent({
    type: 'message_completed',
    channel: 'session_chat',
    session_id: 'chat-1',
    message_id: 'm-1',
    data: { status: 'succeeded', content: '你好' },
  })

  const session = useChatSessionStore.getState().sessions['chat-1']
  assert.equal(session.messages.length, 1)
  assert.equal(session.messages[0].content, '你好')
  assert.equal(session.messages[0].status, 'succeeded')
})

test('chat list store tracks the project session list', () => {
  useChatListStore.setState({ sessions: [] })
  const store = useChatListStore.getState()

  store.addSession(summary('s1', '第一个会话'))
  store.addSession(summary('s2', '第二个会话'))
  store.addSession(summary('s3', '第三个会话'))

  assert.deepEqual(
    useChatListStore.getState().sessions.map((s) => s.id),
    ['s3', 's2', 's1'],
  )

  store.renameSession('s1', '改名了')
  assert.equal(
    useChatListStore.getState().sessions.find((s) => s.id === 's1')?.title,
    '改名了',
  )

  store.removeSession('s1')
  assert.deepEqual(
    useChatListStore.getState().sessions.map((s) => s.id),
    ['s3', 's2'],
  )
})

test('chat list store reorders sessions optimistically and persists', async () => {
  useChatListStore.setState({ sessions: [] })
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
      useChatListStore.getState().sessions.map((s) => s.id),
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
