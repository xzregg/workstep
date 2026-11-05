import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveRobotAvatarState as resolve } from '../src/utils/robotAvatarState'

test('message lifecycle takes priority over stale content, tools and questions', () => {
  const request = { type: 'CUSTOM', name: 'workstep.interaction_request', value: { interaction_id: 'p', method: 'session/request_permission' } }
  assert.equal(resolve({ streaming: false, status: 'stopped', events: [request] }), 'stopped')
  assert.equal(resolve({ streaming: false, status: 'failed' }), 'failed')
  assert.equal(resolve({ streaming: false, error: 'failed' }), 'failed')
  assert.equal(resolve({ streaming: false, events: [request] }), 'done')
  assert.equal(resolve({ streaming: true, events: [request] }), 'waiting')
  assert.equal(resolve({ streaming: true, events: [request, { type: 'CUSTOM', name: 'workstep.interaction_response', value: { interaction_id: 'p', response: { outcome: 'selected' } } }] }), 'connecting')
})

test('real tool lifecycle tracks concurrent calls and does not mistake argument END for execution completion', () => {
  const events = [
    { type: 'TOOL_CALL_START', toolCallId: 'a', kind: 'execute', name: 'Bash' },
    { type: 'TOOL_CALL_START', toolCallId: 'b', kind: 'read', name: 'Read' },
    { type: 'TOOL_CALL_END', toolCallId: 'b' },
  ]
  assert.equal(resolve({ streaming: true, events }), 'searching')
  events.push({ type: 'TOOL_CALL_RESULT', toolCallId: 'b' })
  assert.equal(resolve({ streaming: true, events }), 'working')
  events.push({ type: 'TOOL_CALL_RESULT', toolCallId: 'a', isError: true } as never)
  assert.equal(resolve({ streaming: true, events }), 'thinking', 'a tool failure can still be recovered by the assistant')
  assert.equal(resolve({ streaming: true, events: [{ type: 'TOOL_CALL_START', toolCallId: 'c', toolCallName: 'read_file' }] }), 'searching')
  assert.equal(resolve({ streaming: true, events: [{ type: 'TOOL_CALL_START', toolCallId: 'c', name: 'custom_tool' }] }), 'working')
  assert.equal(resolve({ streaming: true, events: [{ type: 'TOOL_CALL_CHUNK', toolCallId: 'trimmed', status: 'in_progress' }] }), 'working', 'bounded live buffers may no longer contain the start event')
})

test('latest reasoning/text activity wins, including after tools, without requiring raw history on completed messages', () => {
  const text = { type: 'TEXT_MESSAGE_CONTENT', delta: 'answer' }
  const reasoning = { type: 'REASONING_MESSAGE_CHUNK', delta: 'think' }
  assert.equal(resolve({ streaming: true }), 'connecting')
  assert.equal(resolve({ streaming: true, content: 'answer' }), 'writing')
  assert.equal(resolve({ streaming: true, events: [text, reasoning] }), 'thinking')
  assert.equal(resolve({ streaming: true, events: [reasoning, text] }), 'writing')
  assert.equal(resolve({ streaming: true, events: [{ type: 'RUN_ERROR' }] }), 'failed')
  assert.equal(resolve({ streaming: true, events: [{ type: 'RUN_ERROR' }, { type: 'RUN_STARTED' }] }), 'connecting')
  assert.equal(resolve({ streaming: false, events: [{ type: 'RUN_FINISHED', status: 'cancelled' }] }), 'stopped')
})
