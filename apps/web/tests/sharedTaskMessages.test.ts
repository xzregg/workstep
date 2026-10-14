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


test('shared AG-UI lifecycle retains commentary, custom process events, usage and terminal snapshots', () => {
  let messages = applySharedMessageEvent([], { type: 'TEXT_MESSAGE_START', messageId: 'm', channel: 'coordinator', role: 'assistant', engine: 'codex', content: '', created_at: 'start' })
  assert.equal(messages[0]?.channel, 'coordinator')
  messages = applySharedMessageEvent(messages, { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm', phase: 'commentary', delta: 'working' })
  assert.equal(messages[0].content, '')
  assert.equal(messages[0].events[0].delta, 'working')
  messages = applySharedMessageEvent(messages, { type: 'CUSTOM', name: 'workstep.plan', messageId: 'm', value: { entries: [] } })
  assert.equal(messages[0].events[1].name, 'workstep.plan')
  messages = applySharedMessageEvent(messages, { type: 'CUSTOM', name: 'workstep.usage', messageId: 'm', value: { input_tokens: 10 } })
  assert.equal(messages[0].usage.input_tokens, 10)
  messages = applySharedMessageEvent(messages, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', content: 'final' })
  messages = applySharedMessageEvent(messages, { type: 'TEXT_MESSAGE_END', messageId: 'm', status: 'succeeded', content: 'complete', ended_at: 'end' })
  assert.equal(messages[0].content, 'complete')
  assert.equal(messages[0].run_status, 'succeeded')
  assert.equal(messages[0].ended_at, 'end')
})

test('run start and first tool create a message without prematurely ending it', () => {
  const started = applySharedMessageEvent([], { type: 'RUN_STARTED', messageId: 'm', status: 'running' })
  assert.equal(started[0]?.ended_at, null)
  const tool = applySharedMessageEvent([], { type: 'TOOL_CALL_START', messageId: 't', name: 'shell' })
  assert.equal(tool[0]?.events.length, 1)
})

test('changed journal summaries invalidate expanded details so polling can reload them', () => {
  const previous = [{ id: 'm', events: [{ type: 'TOOL_CALL_START' }], event_detail: { available: true, loaded: true, last_event_seq: 1 } }]
  const merged = mergeSharedHistorySnapshot(previous, [{ id: 'm', events: [], event_detail: { available: true, loaded: false, last_event_seq: 2 } }])
  assert.equal(merged[0].event_detail.loaded, false)
  assert.equal(merged[0].event_detail.last_event_seq, 2)
  assert.equal(merged[0].event_detail.loaded_cursor, 1)
  assert.equal(merged[0].events.length, 1)
})

test('polling preserves cached details and the loading guard while fetching appended events', () => {
  const events = [{ type: 'TOOL_CALL_START', sequence: 1 }]
  const previous = [{ id: 'm', events, event_log_path: 'log', event_detail: {
    available: true, loaded: false, loading: true, loaded_cursor: 1, last_event_seq: 2,
  } }]
  const snapshot = [{ id: 'm', events: [], event_log_path: 'log', event_detail: {
    available: true, loaded: false, last_event_seq: 3,
  } }]
  const merged = mergeSharedHistorySnapshot(previous, snapshot)
  assert.deepEqual(merged[0].events, events)
  assert.equal(merged[0].event_detail.loaded_cursor, 1)
  assert.equal(merged[0].event_detail.loading, true)
  assert.equal(merged[0].event_detail.last_event_seq, 3)
  const replaced = mergeSharedHistorySnapshot(previous, [{ ...snapshot[0], event_log_path: 'new-log' }])
  assert.equal(replaced[0].event_detail.loaded_cursor, undefined)
  assert.deepEqual(replaced[0].events, [])
})


test('expanded complete share timelines are not truncated by subsequent live events', () => {
  const events = Array.from({ length: 2001 }, (_, sequence) => ({ type: 'TOOL_CALL_START', sequence }))
  const history = capSharedHistoryEvents({ id: 'm', events, event_detail: { loaded: true } })
  assert.equal(history.events.length, 2001)
  const updated = applySharedMessageEvent([history], { type: 'CUSTOM', name: 'workstep.plan', messageId: 'm' })
  assert.equal(updated[0].events.length, 2002)
  assert.equal(updated[0].events[0].sequence, 0)
  const refreshing = { ...history, event_detail: { loaded: false, loaded_cursor: 2001 } }
  const appended = applySharedMessageEvent([refreshing], { type: 'CUSTOM', name: 'workstep.plan', messageId: 'm' })
  assert.equal(appended[0].events.length, 2002, 'an incremental refresh must retain cached events')
})
