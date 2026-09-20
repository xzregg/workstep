import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildMessageTimeline,
  characterCount,
  timelineText,
} from '../src/utils/messageTimeline.ts'

test('counts Unicode characters in thinking summaries', () => {
  assert.equal(characterCount('思考🙂'), 3)
})

test('keeps assistant text and tool calls in their original order', () => {
  const timeline = buildMessageTimeline([
    { type: 'text_delta', data: { delta: '先检查文件。' } },
    { type: 'tool_use', data: { id: 'read-1', name: 'Read', input: { path: '/repo/provider.py' } } },
    { type: 'tool_result', data: { tool_use_id: 'read-1', content: 'file contents' } },
    { type: 'text_delta', data: { delta: '发现配置需要修改。' } },
    { type: 'tool_use', data: { id: 'edit-1', name: 'Edit', input: { path: '/repo/provider.py' } } },
    { type: 'text_delta', data: { delta: '修改完成。' } },
  ])

  assert.deepEqual(timeline.map((item) => item.type), [
    'text', 'tool', 'text', 'tool', 'text',
  ])
  assert.equal(timeline[1]?.type === 'tool' && timeline[1].activity.result, 'file contents')
  assert.equal(timeline[3]?.type === 'tool' && timeline[3].activity.hasResult, false)
  assert.equal(timelineText(timeline), '先检查文件。发现配置需要修改。修改完成。')
})

test('merges consecutive text deltas into one visible response segment', () => {
  const timeline = buildMessageTimeline([
    { type: 'text_delta', data: { delta: '第一段' } },
    { type: 'text_delta', data: { delta: '继续输出' } },
  ])

  assert.deepEqual(timeline, [{ type: 'text', id: 'text-0', content: '第一段继续输出' }])
})

test('marks failed tool results without moving the original tool call', () => {
  const timeline = buildMessageTimeline([
    { type: 'tool_use', data: { id: 'cmd-1', name: 'Bash', input: { command: 'false' } } },
    { type: 'text_delta', data: { delta: '命令失败，准备重试。' } },
    { type: 'tool_result', data: { tool_use_id: 'cmd-1', content: 'exit 1', is_error: true } },
  ])

  assert.deepEqual(timeline.map((item) => item.type), ['tool', 'text'])
  assert.equal(timeline[0]?.type === 'tool' && timeline[0].activity.isError, true)
})

test('preserves ACP tool kind for protocol-level edit rendering', () => {
  const timeline = buildMessageTimeline([
    {
      type: 'TOOL_CALL_START',
      toolCallId: 'patch-1',
      toolCallName: 'FileChange',
      kind: 'edit',
    },
    {
      type: 'TOOL_CALL_ARGS',
      toolCallId: 'patch-1',
      args: { path: 'apps/web/src/App.tsx' },
    },
  ])

  assert.equal(
    timeline[0]?.type === 'tool' && timeline[0].activity.kind,
    'edit',
  )
})

test('groups consecutive tool calls but starts a new group after assistant text', () => {
  const timeline = buildMessageTimeline([
    { type: 'tool_use', data: { id: 'read-1', name: 'Read' } },
    { type: 'tool_use', data: { id: 'search-1', name: 'Grep' } },
    { type: 'text_delta', data: { delta: '检查完成。' } },
    { type: 'tool_use', data: { id: 'edit-1', name: 'Edit' } },
    { type: 'tool_use', data: { id: 'test-1', name: 'Bash' } },
  ])

  assert.deepEqual(timeline.map((item) => item.type), ['tool-group', 'text', 'tool-group'])
  assert.deepEqual(
    timeline.flatMap((item) => item.type === 'tool-group'
      ? item.activities.map((activity) => activity.id)
      : []),
    ['read-1', 'search-1', 'edit-1', 'test-1'],
  )
})

test('tracks each tool call duration from start and result timestamps', () => {
  const timeline = buildMessageTimeline([
    {
      type: 'tool_use',
      timestamp: '2026-08-29T10:00:00Z',
      data: { id: 'cmd-1', name: 'Bash', input: { command: 'echo 1' } },
    },
    {
      type: 'tool_result',
      timestamp: '2026-08-29T10:00:08Z',
      data: { tool_use_id: 'cmd-1', content: '1' },
    },
  ])

  const tool = timeline[0]
  assert.equal(tool?.type === 'tool' && tool.activity.startedAt, 1_787_997_600_000)
  assert.equal(tool?.type === 'tool' && tool.activity.endedAt, 1_787_997_608_000)
})

test('keeps thinking and tool calls in event order and lets thinking break tool groups', () => {
  const timeline = buildMessageTimeline([
    { type: 'thinking_delta', data: { delta: '先分析。' } },
    { type: 'tool_use', data: { id: 'read-1', name: 'Read' } },
    { type: 'tool_result', data: { tool_use_id: 'read-1', content: 'ok' } },
    { type: 'thinking_delta', data: { delta: '继续判断。' } },
    { type: 'tool_use', data: { id: 'edit-1', name: 'Edit' } },
    { type: 'tool_use', data: { id: 'test-1', name: 'Bash' } },
    { type: 'text_delta', data: { delta: '最终结果。' } },
  ])

  assert.deepEqual(timeline.map((item) => item.type), [
    'thinking', 'tool', 'thinking', 'tool-group', 'text',
  ])
  assert.equal(timeline[0]?.type === 'thinking' && timeline[0].content, '先分析。')
  assert.equal(timeline[2]?.type === 'thinking' && timeline[2].content, '继续判断。')
})

test('tracks the elapsed time of each thinking segment from event timestamps', () => {
  const timeline = buildMessageTimeline([
    { type: 'thinking_delta', timestamp: '2026-08-29T10:00:00Z', data: { delta: '先分析。' } },
    { type: 'thinking_delta', timestamp: '2026-08-29T10:00:42Z', data: { delta: '继续判断。' } },
    { type: 'tool_use', timestamp: '2026-08-29T10:01:12Z', data: { id: 'read-1', name: 'Read' } },
  ])

  const thinking = timeline[0]
  assert.equal(thinking?.type === 'thinking' && thinking.startedAt, 1_787_997_600_000)
  assert.equal(thinking?.type === 'thinking' && thinking.endedAt, 1_787_997_672_000)
})

test('tracks subagent lifecycle as one timeline item updated in place', () => {
  const timeline = buildMessageTimeline([
    { type: 'text_delta', data: { delta: '开始委托子代理。' } },
    { type: 'subagent', data: {
      task_id: 'task-7', description: '实现后端', status: 'running', stage: 'started',
    } },
    { type: 'tool_use', data: { id: 'edit-1', name: 'Edit', input: { path: 'a.py' } } },
    { type: 'subagent', data: {
      task_id: 'task-7', description: '实现后端', status: 'progress', stage: 'progress',
    } },
    { type: 'subagent', data: {
      task_id: 'task-7', description: '实现后端', status: 'completed', stage: 'notification',
      summary: '完成',
    } },
  ])

  assert.deepEqual(timeline.map((item) => item.type), ['text', 'subagent', 'tool'])
  const subagent = timeline[1]
  assert.equal(subagent?.type === 'subagent' && subagent.activity.taskId, 'task-7')
  assert.equal(subagent?.type === 'subagent' && subagent.activity.status, 'completed')
  assert.equal(subagent?.type === 'subagent' && subagent.activity.summary, '完成')
})

test('keeps multiple subagents as separate timeline items', () => {
  const timeline = buildMessageTimeline([
    { type: 'subagent', data: { task_id: 'task-1', description: '调研', status: 'running' } },
    { type: 'subagent', data: { task_id: 'task-2', description: '实现', status: 'running' } },
    { type: 'subagent', data: { task_id: 'task-1', description: '调研', status: 'completed' } },
  ])

  assert.deepEqual(timeline.map((item) => item.type), ['subagent', 'subagent'])
  assert.deepEqual(
    timeline.flatMap((item) => item.type === 'subagent' ? [item.activity.taskId] : []),
    ['task-1', 'task-2'],
  )
})
