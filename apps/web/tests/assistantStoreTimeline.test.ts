import assert from 'node:assert/strict'
import test from 'node:test'

import { createAssistantStore } from '../src/stores/assistantStore.ts'

test('keeps text and tool events on assistant messages for ordered rendering', () => {
  const store = createAssistantStore({ channel: 'flow' })
  store.getState().newSession('session-1')
  store.getState().handleWsEvent({
    type: 'TEXT_MESSAGE_START', channel: 'flow', session_id: 'session-1', messageId: 'message-1',
  })
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
