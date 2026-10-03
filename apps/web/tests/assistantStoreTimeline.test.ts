import assert from 'node:assert/strict'
import test from 'node:test'

import { createAssistantStore } from '../src/stores/assistantStore.ts'
import { buildMessageTimeline } from '../src/utils/messageTimeline.ts'

test('keeps commentary in the process timeline and out of the answer across replay', () => {
  const store = createAssistantStore({ channel: 'session_chat' })
  store.getState().newSession('phases')
  const events = [
    { type: 'TEXT_MESSAGE_CHUNK', phase: 'commentary', source_item_id: 'p1', delta: '我先' },
    { type: 'TEXT_MESSAGE_CHUNK', phase: 'commentary', source_item_id: 'p1', delta: '检查。' },
    { type: 'TOOL_CALL_START', toolCallId: 'read', toolCallName: 'Read' },
    { type: 'TOOL_CALL_RESULT', toolCallId: 'read', output: 'ok' },
    { type: 'TEXT_MESSAGE_CHUNK', phase: 'commentary', source_item_id: 'p2', delta: '正在核对。' },
    { type: 'TEXT_MESSAGE_CHUNK', phase: 'commentary', source_item_id: 'p3', delta: '核对结束。' },
    { type: 'TEXT_MESSAGE_CHUNK', phase: 'final_answer', source_item_id: 'answer', delta: '已完成。' },
  ]
  for (const event of events) {
    store.getState().handleWsEvent({ ...event, channel: 'session_chat', session_id: 'phases', messageId: 'reply' })
  }
  store.getState().handleWsEvent({ type: 'TEXT_MESSAGE_END', status: 'succeeded',
    channel: 'session_chat', session_id: 'phases', messageId: 'reply' })
  const message = store.getState().sessions.phases.messages[0]
  assert.equal(message.content, '已完成。')
  assert.equal(message.events?.length, events.length)
  const timeline = buildMessageTimeline(message.events ?? [])
  assert.deepEqual(timeline.map(item => item.type), ['commentary', 'tool', 'commentary', 'commentary', 'text'])
  assert.equal('content' in timeline[0] && timeline[0].content, '我先检查。')
  const restored = createAssistantStore({ channel: 'session_chat' })
  restored.getState().hydrateSession('phases', [message])
  assert.equal(restored.getState().sessions.phases.messages[0].content, '已完成。')
  assert.deepEqual(buildMessageTimeline(restored.getState().sessions.phases.messages[0].events ?? []), timeline)
})

test('keeps text and tool events on assistant messages for ordered rendering', () => {
  const store = createAssistantStore({ channel: 'flow' })
  store.getState().newSession('session-1')
  store.getState().handleWsEvent({
    type: 'TEXT_MESSAGE_START', channel: 'flow', session_id: 'session-1', messageId: 'message-1',
    created_at: '2026-08-20T10:00:00.000Z',
  })
  assert.equal(store.getState().sessions['session-1'].messages[0].status, 'running')
  assert.equal(
    store.getState().sessions['session-1'].messages[0].created_at,
    '2026-08-20T10:00:00.000Z',
  )
  for (const event of [
    { type: 'TEXT_MESSAGE_CHUNK', delta: '先检查。' },
    { type: 'TOOL_CALL_START', toolCallId: 'read-1', toolCallName: 'Read', args: { path: 'a.py' } },
    { type: 'TOOL_CALL_RESULT', toolCallId: 'read-1', output: 'ok' },
    { type: 'TEXT_MESSAGE_CHUNK', delta: '检查完成。' },
  ]) {
    store.getState().handleWsEvent({
      ...event,
      channel: 'flow',
      session_id: 'session-1',
      messageId: 'message-1',
    })
  }

  const message = store.getState().sessions['session-1'].messages[0]
  assert.equal(message.content, '先检查。检查完成。')
  assert.deepEqual(message.events?.map((event) => event.type), [
    'TEXT_MESSAGE_CHUNK', 'TOOL_CALL_START', 'TOOL_CALL_RESULT', 'TEXT_MESSAGE_CHUNK',
  ])
})

test('keeps compacted AG-UI events on the assistant message timeline', () => {
  const store = createAssistantStore({ channel: 'session_chat' })
  store.getState().newSession('session-compact')
  store.getState().handleWsEvent({
    type: 'TEXT_MESSAGE_START',
    channel: 'session_chat',
    session_id: 'session-compact',
    messageId: 'message-compact',
  })
  store.getState().handleWsEvent({
    type: 'CUSTOM',
    name: 'workstep.compacted',
    value: { summary: '保留任务目标' },
    channel: 'session_chat',
    session_id: 'session-compact',
    messageId: 'message-compact',
  })
  store.getState().handleWsEvent({
    type: 'TEXT_MESSAGE_END',
    status: 'succeeded',
    channel: 'session_chat',
    session_id: 'session-compact',
    messageId: 'message-compact',
  })

  const message = store.getState().sessions['session-compact'].messages[0]
  assert.equal(message.status, 'succeeded')
  assert.deepEqual(message.events?.map((event) => event.name), ['workstep.compacted'])
  assert.equal(message.events?.[0].value?.summary, '保留任务目标')
})

test('loads persisted event details lazily and preserves newer live events', () => {
  const store = createAssistantStore({ channel: 'session_chat' })
  store.getState().hydrateSession('session-lazy', [{
    id: 'message-lazy',
    role: 'assistant',
    content: '已恢复的回答',
    status: 'running',
    events: [{ type: 'usage_update', seq: 2, data: { used: 10 } }],
    event_summary: {
      event_count: 4,
      last_event_seq: 4,
      thought_characters: 12,
      tool_count: 1,
    },
    event_detail: { available: true, loaded: false },
  }])
  store.getState().handleWsEvent({
    type: 'REASONING_MESSAGE_CHUNK',
    channel: 'session_chat',
    session_id: 'session-lazy',
    messageId: 'message-lazy',
    event_sequence: 5,
    delta: '新的实时思考',
  })

  store.getState().setMessageEventDetails('session-lazy', 'message-lazy', [
    { type: 'agent_thought_chunk', seq: 1, data: { content: '历史思考' } },
    { type: 'usage_update', seq: 2, data: { used: 10 } },
  ], { complete: true, next_cursor: null })

  const message = store.getState().sessions['session-lazy'].messages[0]
  assert.deepEqual(message.events?.map((event) => event.seq ?? event.event_sequence), [1, 2, 5])
  assert.equal(message.event_detail?.loaded, true)
  assert.equal(message.event_detail?.loading, false)
  assert.equal(message.event_detail?.complete, true)
})

test('keeps tool name and arguments translated from the same persisted event', () => {
  const store = createAssistantStore({ channel: 'session_chat' })
  store.getState().hydrateSession('session-tools', [{
    id: 'message-tools',
    role: 'assistant',
    content: '检查完成',
    status: 'succeeded',
    event_detail: { available: true, loaded: false },
  }])

  store.getState().setMessageEventDetails('session-tools', 'message-tools', [
    {
      type: 'TOOL_CALL_START',
      sequence: 19,
      toolCallId: 'call-1',
      name: 'read_file',
    },
    {
      type: 'TOOL_CALL_ARGS',
      sequence: 19,
      toolCallId: 'call-1',
      args: '{"path":"README.md"}',
    },
    {
      type: 'TOOL_CALL_RESULT',
      sequence: 20,
      toolCallId: 'call-1',
      output: 'file contents',
    },
  ], { complete: true, next_cursor: null })

  const message = store.getState().sessions['session-tools'].messages[0]
  assert.deepEqual(message.events?.map((event) => event.type), [
    'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_RESULT',
  ])
  const timeline = buildMessageTimeline(message.events ?? [])
  const tool = timeline[0]
  assert.equal(tool?.type, 'tool')
  assert.equal(tool?.type === 'tool' && tool.activity.name, 'read_file')
  assert.equal(tool?.type === 'tool' && tool.activity.input, '{"path":"README.md"}')
})

test('hydrateSession restores flow proposals from persisted history', () => {
  const store = createAssistantStore({
    channel: 'flow_gen',
    proposalEvent: 'workstep.flow_proposals',
    rejectionEvent: 'workstep.flow_proposals_rejected',
    proposalExtractor: (data) => {
      const items = data.proposals
      if (!Array.isArray(items)) return []
      return items
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item) => ({
          id: String(item.id || ''),
          title: String(item.title),
          summary: String(item.summary),
          steps: item.steps,
          nodeCount: Number(item.nodeCount || 0),
        }))
    },
    rejectionMessageExtractor: (data) => String(data.message),
  })

  store.getState().hydrateSession('session-1', [{
    id: 'message-1',
    role: 'assistant',
    content: '请选择方案',
    status: 'succeeded',
    events: [{
      type: 'flow_proposals',
      data: {
        proposals: [{
          id: 'p1', title: '标准版', summary: '需求到发布',
          steps: { nodes: [], connections: [] }, nodeCount: 2,
        }],
      },
    }],
  }])

  const session = store.getState().sessions['session-1']
  assert.equal(session.latestProposals.length, 1)
  assert.equal(session.latestProposals[0].title, '标准版')
  assert.equal(session.latestProposals[0].nodeCount, 2)
  assert.equal(session.rejectionMessage, '')
})

test('hydrateSession restores proposals from AG-UI CUSTOM history shape', () => {
  const store = createAssistantStore({
    channel: 'flow_gen',
    proposalEvent: 'workstep.flow_proposals',
    rejectionEvent: 'workstep.flow_proposals_rejected',
    proposalExtractor: (data) => {
      const items = data.proposals
      if (!Array.isArray(items)) return []
      return items
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item) => ({
          id: String(item.id || ''),
          title: String(item.title),
          summary: String(item.summary),
          steps: item.steps,
          nodeCount: Number(item.nodeCount || 0),
        }))
    },
    rejectionMessageExtractor: (data) => String(data.message),
  })

  store.getState().hydrateSession('session-1', [{
    id: 'message-1',
    role: 'assistant',
    content: '请选择方案',
    status: 'succeeded',
    events: [{
      type: 'CUSTOM',
      name: 'workstep.flow_proposals',
      value: { proposals: [{ id: 'p1', title: '完整版', summary: '含审核', steps: { nodes: [] }, nodeCount: 3 }] },
    }],
  }])

  const session = store.getState().sessions['session-1']
  assert.equal(session.latestProposals[0].title, '完整版')
  assert.equal(session.latestProposals[0].nodeCount, 3)
})

test('hydrateSession restores rejection reason and clears proposals', () => {
  const store = createAssistantStore({
    channel: 'flow_gen',
    proposalEvent: 'workstep.flow_proposals',
    rejectionEvent: 'workstep.flow_proposals_rejected',
    proposalExtractor: (data) => {
      const items = data.proposals
      return Array.isArray(items) ? items as never[] : []
    },
    rejectionMessageExtractor: (data) => String(data.message),
  })

  store.getState().hydrateSession('session-1', [{
    id: 'message-1',
    role: 'assistant',
    content: '方案未通过校验',
    status: 'succeeded',
    events: [{
      type: 'flow_proposals_rejected',
      data: { message: '画布 JSON 未通过校验，已丢弃：缺节点' },
    }],
  }])

  const session = store.getState().sessions['session-1']
  assert.deepEqual(session.latestProposals, [])
  assert.equal(session.rejectionMessage, '画布 JSON 未通过校验，已丢弃：缺节点')
})

test('hydrateSession restores a2ui surfaces from internal and CUSTOM shapes', () => {
  const store = createAssistantStore({ channel: 'flow_gen' })
  const internalPayload = {
    version: 'v0.9.1',
    createSurface: { surfaceId: 'plan-select', catalogId: 'basic' },
  }
  const customPayload = {
    version: 'v0.9.1',
    updateComponents: {
      surfaceId: 'plan-select',
      components: [{ component: 'Text', id: 'hint', text: '请选择一个方案' }],
    },
  }

  store.getState().hydrateSession('session-1', [
    {
      id: 'message-1',
      role: 'assistant',
      content: '请选择方案',
      status: 'succeeded',
      events: [{ type: 'a2ui', data: internalPayload }],
    },
    {
      id: 'message-2',
      role: 'assistant',
      content: '请选择方案',
      status: 'succeeded',
      events: [{ type: 'CUSTOM', name: 'a2ui.surface', value: customPayload }],
    },
  ])

  const session = store.getState().sessions['session-1']
  assert.equal(session.a2uiMessages?.['message-1']?.length, 1)
  assert.deepEqual(session.a2uiMessages?.['message-1']?.[0], internalPayload)
  assert.equal(session.a2uiMessages?.['message-2']?.length, 1)
  assert.deepEqual(session.a2uiMessages?.['message-2']?.[0], customPayload)
})


test('channel prompt snapshot updates the existing message without replacing its streamed text', () => {
  const store = createAssistantStore({ channel: 'channel_chat' })
  store.getState().newSession('channel-session')
  const scope = { channel: 'channel_chat', session_id: 'channel-session', messageId: 'reply' }
  store.getState().handleWsEvent({ ...scope, type: 'TEXT_MESSAGE_START', prompt: 'pending' })
  store.getState().handleWsEvent({ ...scope, type: 'TEXT_MESSAGE_CHUNK', delta: '部分回复' })
  store.getState().handleWsEvent({ ...scope, type: 'TEXT_MESSAGE_START', prompt: 'actual developer input' })
  const messages = store.getState().sessions['channel-session'].messages
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content, '部分回复')
  assert.equal(messages[0].prompt, 'actual developer input')
})


test('history backfills a saved prompt into a cached message without replacing live text', () => {
  const store = createAssistantStore({ channel: 'session_chat' })
  const base = { id: 'old-answer', role: 'assistant' as const, content: '旧回答', status: 'succeeded' }
  store.getState().hydrateSession('old-session', [base])
  store.getState().hydrateSession('old-session', [{ ...base, prompt: '数据库保存的当轮完整输入' }])
  assert.equal(store.getState().sessions['old-session'].messages[0].prompt, '数据库保存的当轮完整输入')
  assert.equal(store.getState().sessions['old-session'].messages[0].content, '旧回答')
  store.getState().handleWsEvent({ type: 'TEXT_MESSAGE_START', channel: 'session_chat',
    session_id: 'old-session', messageId: 'old-answer', prompt: '较新的实传输入' })
  store.getState().hydrateSession('old-session', [{ ...base, prompt: '数据库保存的当轮完整输入' }])
  assert.equal(store.getState().sessions['old-session'].messages[0].prompt, '较新的实传输入')
})
