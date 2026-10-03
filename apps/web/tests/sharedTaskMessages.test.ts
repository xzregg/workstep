import assert from 'node:assert/strict'
import test from 'node:test'
import { applySharedMessageEvent, capSharedHistoryEvents, mergeSharedHistorySnapshot } from '../src/pages/sharedTaskMessages'

test('shared live message events append text, retain process events, and settle status', () => {
  const started = applySharedMessageEvent([], {
    type: 'TEXT_MESSAGE_CHUNK', messageId: 'message', text: 'Hello', step_key: 'build', created_at: '2026-01-01T00:00:00Z',
  })
  assert.equal(started[0].content, 'Hello')
  assert.equal(started[0].run_status, 'running')
  const withTool = applySharedMessageEvent(started, { type: 'TOOL_CALL_START', messageId: 'message', tool: 'shell' })
  assert.equal(withTool[0].events.length, 1)
  const ended = applySharedMessageEvent(withTool, {
    type: 'RUN_FINISHED', messageId: 'message', status: 'succeeded', created_at: '2026-01-01T00:00:01Z',
  })
  assert.equal(ended[0].run_status, 'succeeded')
  assert.equal(ended[0].ended_at, '2026-01-01T00:00:01Z')
  assert.equal(started[0].events.length, 0)
})

test('shared history and live process events stay bounded', () => {
  const events = Array.from({ length: 2001 }, (_, index) => ({ type: 'tool_use', index }))
  const history = capSharedHistoryEvents({ id: 'message', events })
  assert.equal(history.events.length, 2000)
  assert.equal(history.events[0].index, 1)
  const updated = applySharedMessageEvent([history], { type: 'tool_result', messageId: 'message' })
  assert.equal(updated[0].events.length, 2000)
  assert.equal(updated[0].events[0].index, 2)
})

test('shared interaction events attach to the existing message without changing its text', () => {
  const message = { id: 'message', content: 'Working', events: [] }
  const updated = applySharedMessageEvent([message], {
    type: 'CUSTOM', name: 'workstep.interaction_request', message_id: 'message', request_id: 'approval',
  })
  assert.equal(updated[0].content, 'Working')
  assert.equal(updated[0].events[0].request_id, 'approval')
  assert.deepEqual(message.events, [])
})

 test('polled share snapshots retain older history and loaded details but remove settled interactions', () => {
  const details = [{ type: 'TOOL_CALL_START', tool: 'shell' }]
  const previous = [
    { id: 'older', content: 'old' },
    { id: 'current', content: 'before', events: details, event_detail: { loaded: true } },
    { id: 'gateway-interaction:resolved', events: [] },
  ]
  const merged = mergeSharedHistorySnapshot(previous, [
    { id: 'current', content: 'after', events: [], event_detail: { loaded: false } },
    { id: 'gateway-interaction:pending', events: [] },
  ])
  assert.deepEqual(merged.map(item => item.id), ['older', 'current', 'gateway-interaction:pending'])
  assert.equal(merged[1].content, 'after')
  assert.deepEqual(merged[1].events, details)
  assert.equal(merged[1].event_detail.loaded, true)
})
