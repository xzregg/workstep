import assert from 'node:assert/strict'
import test from 'node:test'

import { createAssistantStore } from '../src/stores/assistantStore.ts'

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
