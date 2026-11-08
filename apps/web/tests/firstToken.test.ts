import assert from 'node:assert/strict'
import test from 'node:test'
import { firstTokenDelaySeconds } from '../src/components/MessageResponseFooter'
import { createAssistantStore } from '../src/stores/assistantStore'
import { useTaskStore } from '../src/stores/taskStore'
const start = '2026-11-08T00:00:00Z'
const at = (seconds: number) => Date.parse(start) + seconds * 1000

test('first token requires model output, not message start, empty chunks or user input', () => {
  const events = [
    { type: 'TEXT_MESSAGE_START', timestamp: at(0) },
    { type: 'TEXT_MESSAGE_CHUNK', delta: '', timestamp: at(1) },
    { type: 'TEXT_MESSAGE_CHUNK', role: 'user', delta: 'hello', timestamp: at(2) },
  ]
  assert.equal(firstTokenDelaySeconds(events, start), null)
  assert.equal(firstTokenDelaySeconds([...events, { type: 'REASONING_MESSAGE_CHUNK', delta: 'thinking', timestamp: at(3) }], start), 3)
  assert.equal(firstTokenDelaySeconds([...events, { type: 'TOOL_CALL_START', toolCallName: 'Bash', timestamp: at(4) }], start), 4)
})
test('persisted timestamp wins over a truncated event tail, including numeric timestamps', () => {
  assert.equal(firstTokenDelaySeconds([{ type: 'TEXT_MESSAGE_CHUNK', delta: 'late', timestamp: at(30) }], start, { first_output_at: at(3) }), 3)
})
test('assistant retains first output when the live event cap drops it and the view remounts', () => {
  const store = createAssistantStore({ channel: 'session_chat' })
  const send = (event: Record<string, unknown>) => store.getState().handleWsEvent({ channel: 'session_chat', session_id: 'chat', messageId: 'reply', ...event } as any)
  send({ type: 'TEXT_MESSAGE_START', role: 'assistant', created_at: start, timestamp: at(0) })
  send({ type: 'REASONING_MESSAGE_CHUNK', delta: 'first', timestamp: at(3) })
  for (let i = 0; i < 2005; i++) send({ type: 'TEXT_MESSAGE_CHUNK', delta: 'x', timestamp: at(10 + i) })
  const message = store.getState().sessions.chat.messages[0]
  assert.equal(firstTokenDelaySeconds(message.events, message.created_at, message.event_summary), 3)
})
test('task live message also retains first tool output across event trimming', () => {
  useTaskStore.setState({ liveMessages: {}, events: {}, content: {} })
  const send = (event: Record<string, unknown>) => useTaskStore.getState().handleWsEvent({ task_id: 'ttft-task', channel: 'execution', messageId: 'reply', ...event } as any)
  send({ type: 'TEXT_MESSAGE_START', role: 'assistant', created_at: start, timestamp: at(0) })
  send({ type: 'TOOL_CALL_START', toolCallName: 'Bash', timestamp: at(3) })
  for (let i = 0; i < 2005; i++) send({ type: 'TEXT_MESSAGE_CHUNK', delta: 'x', timestamp: at(10 + i) })
  const message = useTaskStore.getState().liveMessages['ttft-task'].reply
  assert.equal(firstTokenDelaySeconds(message.events, start, message.event_summary), 3)
})

test('restored legacy history captures its first output before new chunks arrive', () => {
  const store = createAssistantStore({ channel: 'session_chat' })
  store.getState().hydrateSession('chat', [{ id: 'reply', role: 'assistant', status: 'running', content: '', created_at: start,
    events: [{ type: 'REASONING_MESSAGE_CHUNK', delta: 'first', timestamp: at(3) }] }])
  store.getState().handleWsEvent({ type: 'TEXT_MESSAGE_CHUNK', channel: 'session_chat', session_id: 'chat', messageId: 'reply', delta: 'later', timestamp: at(30) })
  const message = store.getState().sessions.chat.messages[0]
  assert.equal(firstTokenDelaySeconds(message.events, start, message.event_summary), 3)
})
