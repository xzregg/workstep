import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTaskConversationTimeline, selectTaskConversationFeed } from '../src/components/taskConversationFeed.ts'

for (const channel of ['coordinator', 'execution']) {
  test(`${channel} insertion stays old reply, user, new reply through history recovery`, () => {
    const history = [
      { id: 'old', channel, role: 'assistant', content: '前段回复', sequence: 1,
        run_status: 'succeeded', created_at: '2026-10-07T06:11:42Z' },
      { id: 'insert', channel, role: 'user', content: '补充要求', sequence: 2,
        run_status: 'succeeded', created_at: '2026-10-07T06:14:03Z' },
    ]
    const live = {
      old: { ...history[0], status: 'running' },
      new: { id: 'new', channel, role: 'assistant', content: '后段回复',
        status: 'running', created_at: '2026-10-07T06:14:04Z', reply_to_message_id: 'insert' },
    }
    const build = (historyMessages: any[]) => buildTaskConversationTimeline({
      historyMessages, liveMessages: live as any, actionRuns: [],
      coordinatorRunning: channel === 'coordinator', actionTitle: (title) => title,
    }).orderedMessages
    assert.deepEqual(build(history).map((message) => message.id), ['old', 'insert', 'new'])
    assert.equal(build(history)[0].run_status, 'succeeded')
    const recovered = build([...history, { ...live.new, sequence: 3, run_status: 'succeeded' }])
    assert.deepEqual(recovered.map((message) => message.id), ['old', 'insert', 'new'])
    assert.equal(recovered[2].run_status, 'succeeded')
  })
}

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
    coordinatorEngine: 'codex_sdk',
    coordinatorModel: 'gpt-5.5',
    actionTitle: (title) => `操作：${title}`,
  })
  assert.deepEqual(timeline.orderedMessages.map((message) => message.id), [
    'prompt', 'pending-coordinator-thinking', 'action-user', 'action-reply',
  ])
  const pending = timeline.orderedMessages.find((message) => message.id === 'pending-coordinator-thinking')
  assert.equal(pending?.engine, 'codex_sdk')
  assert.equal(pending?.model, 'gpt-5.5')
  assert.equal(timeline.orderedMessages.find((message) => message.id === 'action-reply')?.content, '完成')
  assert.equal(timeline.orderedMessages.find((message) => message.id === 'action-user')?.content, '操作：检查')
})
