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
  assert.equal(isVisibleHistoryMessage({
    channel: 'execution', role: 'assistant', content: '', run_status: 'failed',
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

test('describes the latest live engine activity before text arrives', () => {
  assert.equal(liveExecutionStatus([
    { type: 'thinking_delta', data: { delta: '分析' } },
    { type: 'tool_use', data: { name: 'Bash' } },
  ]), '正在执行工具：Bash')
  assert.equal(liveExecutionStatus([]), '引擎处理中')
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
