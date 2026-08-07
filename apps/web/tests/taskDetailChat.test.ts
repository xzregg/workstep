import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createOptimisticUserMessage,
  isVisibleHistoryMessage,
  isVisibleLiveExecutionMessage,
  isUnpersistedLiveMessage,
  isTaskCompleted,
  isTaskNotStarted,
  isNearConversationBottom,
  liveExecutionStatus,
  mergeHistoryMessageWithLive,
  orderConversationMessages,
  resolveMessagePrompt,
  shouldRenderLegacyExecution,
  stageAvatarText,
} from '../src/pages/taskDetailChat.ts'

test('creates a user message that can render before the run request resolves', () => {
  const message = createOptimisticUserMessage(
    'pending-1',
    '继续检查 token 统计',
    'implement',
    '2024-08-03T00:00:00+00:00',
  )

  assert.deepEqual(message, {
    id: 'pending-1',
    role: 'user',
    content: '继续检查 token 统计',
    step_key: 'implement',
    run_status: 'pending',
    created_at: '2024-08-03T00:00:00+00:00',
    events: [],
  })
})

test('detects tasks that have not started from their configured stage', () => {
  assert.equal(isTaskNotStarted([
    { status: 'skipped', started_at: null },
    { status: 'pending', started_at: null },
  ]), true)
  assert.equal(isTaskNotStarted([
    { status: 'passed', started_at: '2026-08-04T00:00:00+00:00' },
  ]), false)
  assert.equal(isTaskNotStarted([
    { status: 'running', started_at: '2026-08-04T00:00:00+00:00' },
  ]), false)
})

test('distinguishes completed tasks from ready tasks that never started', () => {
  assert.equal(isTaskCompleted([
    { status: 'skipped', started_at: null },
    { status: 'passed', started_at: '2026-08-04T00:00:00+00:00' },
  ]), true)
  assert.equal(isTaskCompleted([
    { status: 'skipped', started_at: null },
    { status: 'pending', started_at: null },
  ]), false)
})

test('shows only stage execution replies in the main task conversation', () => {
  assert.equal(isVisibleHistoryMessage({
    channel: 'execution', role: 'assistant', content: '阶段结果', run_status: 'succeeded',
  }), true)
  assert.equal(isVisibleHistoryMessage({
    channel: 'review', role: 'assistant', content: '审核结果', run_status: 'succeeded',
  }), true)
  // 已停止/失败但无内容的执行消息仍保留展示（附带失败徽标）。
  assert.equal(isVisibleHistoryMessage({
    channel: 'execution', role: 'assistant', content: '', run_status: 'failed',
  }), true)
  assert.equal(isVisibleHistoryMessage({
    channel: 'execution', role: 'assistant', content: '', run_status: 'succeeded',
  }), false)
  assert.equal(isVisibleHistoryMessage({
    channel: 'coordinator', role: 'assistant', content: '协调回复', run_status: 'succeeded',
  }), true)
})

test('keeps a running stage visible and uses the stage as its avatar', () => {
  assert.equal(isVisibleLiveExecutionMessage({
    channel: 'execution', content: '', status: 'running',
  }), true)
  assert.equal(isVisibleLiveExecutionMessage({
    channel: 'review', content: '审核中', status: 'running',
  }), false)
  assert.equal(stageAvatarText('任务理解'), '任务')
  assert.equal(stageAvatarText('测试'), '测试')
})

test('does not render a live message again after history contains it', () => {
  const persistedIds = new Set(['message-1'])
  assert.equal(isUnpersistedLiveMessage({ id: 'message-1' }, persistedIds), false)
  assert.equal(isUnpersistedLiveMessage({ id: 'message-2' }, persistedIds), true)
})

test('merges live execution updates into a persisted running message', () => {
  const merged = mergeHistoryMessageWithLive(
    {
      id: 'message-1',
      content: '',
      events: [],
      run_status: 'running',
      prompt: 'persisted prompt',
    },
    {
      id: 'message-1',
      content: '实时输出',
      events: [{ type: 'text_delta', data: { delta: '实时输出' } }],
      status: 'running',
      prompt: 'live prompt',
    },
  )

  assert.equal(merged.content, '实时输出')
  assert.equal(merged.events.length, 1)
  assert.equal(merged.prompt, 'live prompt')
  assert.equal(merged.run_status, 'running')
})

test('orders sealed stage segments around an inserted user message', () => {
  const ordered = orderConversationMessages([
    { id: 'B', role: 'assistant', sequence: 2, created_at: '2026-08-07T10:01:00.500Z', content: '第二段输出' },
    { id: 'U', role: 'user', sequence: 1, created_at: '2026-08-07T10:01:00.000Z', content: '插入内容' },
    { id: 'A', role: 'assistant', sequence: 0, created_at: '2026-08-07T10:00:00.000Z', content: '第一段输出' },
  ])
  assert.deepEqual(ordered.map((m) => m.id), ['A', 'U', 'B'])
})

test('keeps a live-insert user message between stage segments by server time', () => {
  // 乐观消息按服务端 created_at 落位：即使客户端时钟与 daemon 有偏差，
  // 插入消息也始终位于段 A 与段 B 之间（B 是引擎 ack 后才创建的服务端时间）。
  const ordered = orderConversationMessages([
    { id: 'A', role: 'assistant', created_at: '2026-08-07T10:00:00.000Z', content: '第一段输出' },
    { id: 'U', role: 'user', created_at: '2026-08-07T10:01:00.000Z', content: '插入内容' },
    { id: 'B', role: 'assistant', created_at: '2026-08-07T10:01:00.500Z', content: '第二段输出' },
  ])
  assert.deepEqual(ordered.map((m) => m.id), ['A', 'U', 'B'])
})

test('falls back to created_at when only one side carries a sequence', () => {
  const ordered = orderConversationMessages([
    { id: 'B', role: 'assistant', created_at: '2026-08-07T10:01:00.500Z', content: '第二段输出' },
    { id: 'U', role: 'user', sequence: 1, created_at: '2026-08-07T10:01:00.000Z', content: '插入内容' },
    { id: 'A', role: 'assistant', sequence: 0, created_at: '2026-08-07T10:00:00.000Z', content: '第一段输出' },
  ])
  assert.deepEqual(ordered.map((m) => m.id), ['A', 'U', 'B'])
})

test('moves a still-running stage message below the inserted user message', () => {
  // 阶段仍在进行：按当前时间（创建时间 + 已进行时长）排序，晚于用户消息 → 挪到下方。
  const now = new Date('2026-08-07T10:05:00.000Z').getTime()
  const ordered = orderConversationMessages([
    { id: 'A', role: 'assistant', run_status: 'running', created_at: '2026-08-07T10:00:00.000Z', content: '正在输出' },
    { id: 'U', role: 'user', created_at: '2026-08-07T10:01:00.000Z', content: '插入内容', run_status: 'completed' },
  ], now)
  assert.deepEqual(ordered.map((m) => m.id), ['U', 'A'])
})

test('sorts finished stage messages by their completion time', () => {
  // 段 A 在用户消息之后才完成（ended_at 晚于用户发送时间）→ 挪到用户消息下面；
  // 更早完成的阶段消息保持在用户消息上面。
  const ordered = orderConversationMessages([
    { id: 'A', role: 'assistant', run_status: 'succeeded', created_at: '2026-08-07T10:00:00.000Z', ended_at: '2026-08-07T10:02:00.000Z', content: '第一段输出' },
    { id: 'U', role: 'user', created_at: '2026-08-07T10:01:00.000Z', content: '插入内容', run_status: 'completed' },
    { id: 'Prev', role: 'assistant', run_status: 'succeeded', created_at: '2026-08-07T09:58:00.000Z', ended_at: '2026-08-07T09:59:00.000Z', content: '早前输出' },
  ])
  assert.deepEqual(ordered.map((m) => m.id), ['Prev', 'U', 'A'])
})

test('describes the latest live engine activity before text arrives', () => {
  assert.equal(liveExecutionStatus([
    { type: 'thinking_delta', data: { delta: '分析' } },
    { type: 'tool_use', data: { name: 'Bash' } },
  ]), '正在执行工具：Bash')
  assert.equal(liveExecutionStatus([]), '处理中')
})

test('only follows new messages while the reader stays near the bottom', () => {
  assert.equal(isNearConversationBottom(1000, 620, 300), true)
  assert.equal(isNearConversationBottom(1000, 300, 300), false)
})

test('does not render the legacy running placeholder beside a structured message', () => {
  assert.equal(shouldRenderLegacyExecution(true, false, '', true), false)
  assert.equal(shouldRenderLegacyExecution(true, false, '', false), true)
})

test('adds the live coordinator prompt to an already persisted queued message', () => {
  assert.equal(resolveMessagePrompt(null, '  complete coordinator prompt  '), 'complete coordinator prompt')
  assert.equal(resolveMessagePrompt('persisted prompt', undefined), 'persisted prompt')
})
