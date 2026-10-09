import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeActionMessages } from '../src/utils/actionConversation.ts'

const run = {
  run_id: 'run-1', user_message_id: 'action-user', reply_message_id: 'action-reply',
  title: '启动服务', output: 'http://localhost:3000', status: 'running',
  started_at: '2026-09-24T10:01:00Z', ended_at: null,
}

for (const runs of [[], [run]]) {
  test(`Action merge preserves existing conversation order with skewed clocks (${runs.length} runs)`, () => {
    const messages = [
      { id: 'user', role: 'user', content: '请求', created_at: '2026-09-24T10:03:00Z' },
      { id: 'reply', role: 'assistant', content: '回答', created_at: '2026-09-24T10:02:00Z' },
    ]
    const merged = mergeActionMessages(messages, runs, () => false, (item, role) => ({
      id: role === 'user' ? item.user_message_id : item.reply_message_id,
      role, content: '', created_at: item.started_at,
    }))
    assert.deepEqual(merged.filter((message) => ['user', 'reply'].includes(message.id))
      .map((message) => message.id), ['user', 'reply'])
  })
}

test('a missing Action user is inserted before its already streamed reply', () => {
  const messages = [
    { id: 'before', content: '', created_at: run.started_at },
    { id: run.reply_message_id, content: '', created_at: run.started_at },
    { id: 'after', content: '', created_at: run.started_at },
  ]
  const merged = mergeActionMessages(messages, [run], (message) => message.id === run.reply_message_id,
    (item, role) => ({ id: role === 'user' ? item.user_message_id : item.reply_message_id,
      content: '', created_at: item.started_at }))
  assert.deepEqual(merged.map((message) => message.id), ['before', 'action-user', 'action-reply', 'after'])
})

test('Action execution becomes two chronological conversation messages', () => {
  const messages = [
    { id: 'before', role: 'assistant', content: '之前', created_at: '2026-09-24T10:00:00Z' },
    { id: 'after', role: 'user', content: '之后', created_at: '2026-09-24T10:02:00Z' },
  ]
  const merged = mergeActionMessages(messages, [run], (message) => message.role === 'action', (item, role) => ({
    id: role === 'user' ? item.user_message_id : item.reply_message_id,
    role: 'action', content: role === 'user' ? `执行快捷动作：${item.title}` : item.output,
    created_at: item.started_at,
  }))
  assert.deepEqual(merged.map((message) => message.id), ['before', 'action-user', 'action-reply', 'after'])
  assert.equal(merged[2].actionRun?.status, 'running')
})

test('persisted Action messages are updated without duplication', () => {
  const messages = [
    { id: 'action-user', role: 'action', content: '执行快捷动作：启动服务', created_at: run.started_at },
    { id: 'action-reply', role: 'action', content: '', created_at: run.started_at },
  ]
  const merged = mergeActionMessages(messages, [run], (message) => message.role === 'action', () => {
    throw new Error('existing messages must be reused')
  })
  assert.equal(merged.length, 2)
  assert.equal(merged[1].content, run.output)
})

test('persisted Action replies arriving before their users are reordered without moving ordinary messages', () => {
  const messages = [
    { id: 'before', content: '之前' },
    { id: run.reply_message_id, content: '', engine: 'action' },
    { id: 'ordinary', content: '普通消息' },
    { id: run.user_message_id, content: '执行快捷动作', engine: 'action' },
    { id: 'after', content: '之后' },
  ]
  const merged = mergeActionMessages(messages, [run], message => message.engine === 'action', () => {
    throw new Error('existing messages must be reused')
  })
  assert.deepEqual(merged.map(message => message.id), ['before', 'action-user', 'action-reply', 'ordinary', 'after'])
  assert.equal(merged[2].content, run.output)
  assert.deepEqual(mergeActionMessages(merged, [run], message => message.engine === 'action', () => {
    throw new Error('existing messages must be reused')
  }).map(message => message.id), merged.map(message => message.id))
})
