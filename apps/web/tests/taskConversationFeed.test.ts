import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTaskConversationTimeline, selectTaskConversationFeed } from '../src/components/taskConversationFeed.ts'

test('conversation feed excludes persisted live messages and user execution echoes', () => {
  const feed = selectTaskConversationFeed(
    [{ id: 'saved', channel: 'execution' }],
    {
      saved: { id: 'saved', channel: 'execution', role: 'assistant', status: 'running' },
      execution: { id: 'execution', channel: 'execution', role: 'assistant', status: 'running' },
      user: { id: 'user', channel: 'execution', role: 'user', status: 'completed' },
      coordinator: { id: 'coordinator', channel: 'coordinator', role: 'assistant', status: 'running' },
    } as any,
  )

  assert.deepEqual(feed.liveExecutionMessages.map((message) => message.id), ['execution'])
  assert.deepEqual(feed.liveCoordinatorMessages.map((message) => message.id), ['coordinator'])
  assert.deepEqual(feed.unpersistedLiveMessages.map((message) => message.id), [
    'execution', 'user', 'coordinator',
  ])
  assert.equal(feed.hasStructuredExecutionMessage, true)
})

test('timeline merges action runs and puts a pending coordinator reply after its prompt', () => {
  const timeline = buildTaskConversationTimeline({
    historyMessages: [{
      id: 'prompt', channel: 'coordinator', role: 'user', content: '请规划',
      created_at: '2026-01-01T00:00:00Z',
    }],
    liveMessages: {},
    actionRuns: [{
      user_message_id: 'action-user', reply_message_id: 'action-reply',
      title: '检查', output: '完成', status: 'succeeded',
      started_at: '2026-01-01T00:00:01Z',
    }],
    coordinatorRunning: true,
    actionTitle: (title) => `操作：${title}`,
  })
  assert.deepEqual(timeline.orderedMessages.map((message) => message.id), [
    'prompt', 'pending-coordinator-thinking', 'action-user', 'action-reply',
  ])
  assert.equal(timeline.orderedMessages.find((message) => message.id === 'action-reply')?.content, '完成')
  assert.equal(timeline.orderedMessages.find((message) => message.id === 'action-user')?.content, '操作：检查')
})
