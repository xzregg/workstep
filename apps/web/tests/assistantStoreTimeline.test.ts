import assert from 'node:assert/strict'
import test from 'node:test'

import { createAssistantStore } from '../src/stores/assistantStore.ts'

test('keeps text and tool events on assistant messages for ordered rendering', () => {
  const store = createAssistantStore({ channel: 'flow' })
  store.getState().newSession('session-1')
  store.getState().handleWsEvent({
    type: 'message_started', channel: 'flow', session_id: 'session-1', message_id: 'message-1', data: {},
  })
  for (const event of [
    { type: 'text_delta', data: { delta: '先检查。' } },
    { type: 'tool_use', data: { id: 'read-1', name: 'Read', input: { path: 'a.py' } } },
    { type: 'tool_result', data: { tool_use_id: 'read-1', content: 'ok' } },
    { type: 'text_delta', data: { delta: '检查完成。' } },
  ]) {
    store.getState().handleWsEvent({
      ...event,
      channel: 'flow',
      session_id: 'session-1',
      message_id: 'message-1',
    })
  }

  const message = store.getState().sessions['session-1'].messages[0]
  assert.equal(message.content, '先检查。检查完成。')
  assert.deepEqual(message.events?.map((event) => event.type), [
    'text_delta', 'tool_use', 'tool_result', 'text_delta',
  ])
})
