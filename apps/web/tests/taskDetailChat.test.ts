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
  conversationBottomScrollTop,
  isManualReviewMessage,
  isMessageReviewActionable,
  liveExecutionStatus,
  mergeHistoryMessageWithLive,
  orderConversationMessages,
  resolveMessageReview,
  resolveMessagePrompt,
  shouldRenderLegacyExecution,
  stageAvatarText,
} from '../src/pages/taskDetailChat.ts'

test('matches each historical review message to its own review attempt', () => {
  const reviews = [
    {
      id: 'review-pending', step_key: 'start', status: 'pending',
      started_at: '2026-08-11T08:59:03.640614+00:00',
    },
    {
      id: 'review-passed', step_key: 'start', status: 'passed',
      started_at: '2026-08-11T08:52:50.010814+00:00',
    },
    {
      id: 'review-rejected', step_key: 'start', status: 'rejected',
      started_at: '2026-08-11T08:42:39.779239+00:00',
    },
  ]

  assert.equal(resolveMessageReview({
    channel: 'review', step_key: 'start',
    started_at: '2026-08-11T08:42:39.779239+00:00',
  }, reviews)?.id, 'review-rejected')
  assert.equal(resolveMessageReview({
    channel: 'review', step_key: 'start',
    started_at: '2026-08-11T08:52:50.010814+00:00',
  }, reviews)?.id, 'review-passed')
  assert.equal(resolveMessageReview({
    channel: 'review', step_key: 'start',
    events: [{ type: 'review_context', data: { review_run_id: 'review-pending' } }],
  }, reviews)?.id, 'review-pending')

  assert.equal(isMessageReviewActionable({
    channel: 'review', step_key: 'start',
    started_at: '2026-08-11T08:42:39.779239+00:00',
  }, reviews, 'awaiting_review'), false)
  assert.equal(isMessageReviewActionable({
    channel: 'review', step_key: 'start',
    events: [{ type: 'review_context', data: { review_run_id: 'review-pending' } }],
  }, reviews, 'awaiting_review'), true)
})

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

test('marks live-inserted user messages as user so they never render as execution bubbles', () => {
  // 引擎只发 live_message 确认，store 把该事件对应消息标记为 user；
  // 左侧执行消息渲染应将其排除，避免插入消息出现第二个流式气泡。
  assert.equal(isVisibleLiveExecutionMessage({
    id: 'mid-1', channel: 'execution', role: 'user', content: '插入内容', status: 'running',
  }), false)
  assert.equal(isVisibleLiveExecutionMessage({
    id: 'mid-1', channel: 'execution', role: 'assistant', content: '', status: 'running',
  }), true)
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

test('keeps the inserted user message completed after its live_message ack', () => {
  // 插入的用户消息没有 message_completed 事件，只有 live_message 确认；
  // 合并时必须沿用历史 run_status，避免右侧用户气泡被误标为 streaming。
  const merged = mergeHistoryMessageWithLive(
    {
      id: 'mid-1',
      role: 'user',
      content: '插入内容',
      events: [],
      run_status: 'completed',
      created_at: '2026-08-12T08:00:00+00:00',
    },
    {
      id: 'mid-1',
      channel: 'execution',
      role: 'user',
      content: '插入内容',
      events: [{ type: 'live_message', data: { status: 'delivered' } }],
      status: 'running',
    },
  )

  assert.equal(merged.run_status, 'completed')
  assert.equal(merged.role, 'user')
})

test('keeps persisted interaction requests when the live update contains their response', () => {
  const merged = mergeHistoryMessageWithLive(
    {
      id: 'message-1',
      content: '',
      events: [{
        type: 'interaction_request',
        data: { interaction_id: 'request-1', method: 'elicitation/create', params: {} },
      }],
      run_status: 'running',
    },
    {
      id: 'message-1',
      content: '',
      events: [{
        type: 'interaction_response',
        data: { interaction_id: 'request-1', result: { action: 'accept', content: {} } },
      }],
      status: 'running',
    },
  )

  assert.deepEqual(merged.events.map((event: { type: string }) => event.type), [
    'interaction_request',
    'interaction_response',
  ])
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

test('keeps a stage review after its execution when their displayed times are equal', () => {
  // 真实任务中审核记录先于 execution finally 封口约 0.7ms；两条消息在界面上显示为同一秒。
  // 审核是该阶段执行结果的后续消息，应按服务端 sequence 保持在执行消息之后。
  const ordered = orderConversationMessages([
    {
      id: 'execution',
      step_key: 'start',
      channel: 'execution',
      role: 'assistant',
      sequence: 1,
      run_status: 'succeeded',
      created_at: '2026-08-11T08:42:16.730656Z',
      ended_at: '2026-08-11T08:42:39.781289Z',
    },
    {
      id: 'review',
      step_key: 'start',
      channel: 'review',
      role: 'assistant',
      sequence: 2,
      run_status: 'completed',
      created_at: '2026-08-11T08:42:39.780547Z',
    },
  ])

  assert.deepEqual(ordered.map((message) => message.id), ['execution', 'review'])
})

test('describes the latest live engine activity before text arrives', () => {
  assert.equal(liveExecutionStatus([
    { type: 'thinking_delta', data: { delta: '分析' } },
    { type: 'tool_use', data: { name: 'Bash' } },
  ]), '正在执行工具：Bash')
  assert.equal(liveExecutionStatus([
    { type: 'status', data: { status: 'idle_timeout' } },
  ]), '等待插入消息超时，会话已自动结束')
  assert.equal(liveExecutionStatus([
    { type: 'status', data: { status: 'done' } },
  ]), '回复已完成，等待插入消息…')
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

test('flags manual review messages so they render without a thinking trace', () => {
  const reviews = [
    {
      id: 'review-manual', step_key: 'start', status: 'pending', mode: 'manual',
      started_at: '2026-08-11T08:59:03.640614+00:00',
    },
    {
      id: 'review-auto', step_key: 'impl', status: 'passed', mode: 'auto',
      started_at: '2026-08-11T08:52:50.010814+00:00',
    },
  ]

  assert.equal(isManualReviewMessage({
    channel: 'review', step_key: 'start',
    events: [{ type: 'review_context', data: { review_run_id: 'review-manual' } }],
  }, reviews), true)
  assert.equal(isManualReviewMessage({
    channel: 'review', step_key: 'impl',
    events: [{ type: 'review_context', data: { review_run_id: 'review-auto' } }],
  }, reviews), false)
  // 非审核消息不受影响
  assert.equal(isManualReviewMessage({
    channel: 'execution', step_key: 'start', engine: 'codex',
  }, reviews), false)
  // 旧数据没有匹配到审核记录时，按引擎缺失兜底（人工审核不跑引擎）
  assert.equal(isManualReviewMessage({
    channel: 'review', step_key: 'unknown', engine: null,
  }, reviews), true)
  assert.equal(isManualReviewMessage({
    channel: 'review', step_key: 'unknown', engine: 'codex',
  }, reviews), false)
})

test('conversationBottomScrollTop pins to the bottom without going negative', () => {
  assert.equal(conversationBottomScrollTop(500, 300), 200)
  assert.equal(conversationBottomScrollTop(200, 300), 0)
  assert.equal(conversationBottomScrollTop(0, 0), 0)
})
