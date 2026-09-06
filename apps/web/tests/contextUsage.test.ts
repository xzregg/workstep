import assert from 'node:assert/strict'
import test from 'node:test'

import {
  estimateTokens,
  estimateUsageFromEvents,
  usageFromEvents,
} from '../src/utils/contextUsage.js'

test('CJK characters map to ~1 token per character', () => {
  // 10 个汉字 → 10 token
  assert.equal(estimateTokens('一二三四五六七八九十'), 10)
  // 4 个 ASCII 字符 → 1 token
  assert.equal(estimateTokens('abcd'), 1)
  // 空串 → 0
  assert.equal(estimateTokens(''), 0)
})

test('mixed CJK and ASCII content follows the 1:1 / 1:4 rule', () => {
  const tokens = estimateTokens('你好 world 世界')
  // 你好 = 2，世界 = 2，world = 5 字符 ≈ 1.25 → round
  assert.ok(tokens >= 5 && tokens <= 6)
})

test('estimateUsageFromEvents counts assistant text as output tokens', () => {
  const usage = estimateUsageFromEvents([
    { type: 'TEXT_MESSAGE_START' },
    { type: 'TEXT_MESSAGE_CHUNK', delta: '这是流式输出的内容' },
    { type: 'TEXT_MESSAGE_CHUNK', delta: '继续输出更多文字' },
  ])
  assert.ok(usage)
  assert.equal(usage.output_tokens, 17) // 9 + 8 个汉字
  assert.equal(usage.input_tokens, 0)
  assert.equal(usage.total_tokens, 17)
  assert.equal(usage.estimated, true)
})

test('estimateUsageFromEvents counts user input as input tokens', () => {
  const usage = estimateUsageFromEvents([
    { type: 'TEXT_MESSAGE_CHUNK', role: 'user', delta: '帮我写一个工具函数' },
    { type: 'TEXT_MESSAGE_CHUNK', delta: '好的，这是实现' },
  ])
  assert.ok(usage)
  assert.equal(usage.input_tokens, 9) // 9 个汉字
  assert.equal(usage.output_tokens, 6) // 6 个汉字
  assert.equal(usage.total_tokens, 15)
})

test('estimateUsageFromEvents includes reasoning and tool activity', () => {
  const usage = estimateUsageFromEvents([
    { type: 'REASONING_MESSAGE_CHUNK', delta: '先分析一下问题' },
    { type: 'TOOL_CALL_START', toolCallId: 'call-1' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'call-1', args: { command: 'ls -la' } },
    { type: 'TOOL_CALL_RESULT', toolCallId: 'call-1', output: 'total 8\nREADME.md' },
    { type: 'TEXT_MESSAGE_CHUNK', delta: '完成' },
  ])
  assert.ok(usage)
  assert.ok(usage.input_tokens > 0) // 工具入参
  assert.ok(usage.output_tokens > 0) // 思考 + 工具结果 + 回复
  assert.equal(usage.estimated, true)
})

test('estimateUsageFromEvents dedupes full args vs incremental chunks', () => {
  const usage = estimateUsageFromEvents([
    { type: 'TOOL_CALL_ARGS', toolCallId: 'call-1', args: { pattern: 'import' } },
    { type: 'TOOL_CALL_CHUNK', toolCallId: 'call-1', delta: 'import' },
  ])
  assert.ok(usage)
  // 完整入参已计数，增量分片不重复累计
  assert.equal(usage.input_tokens, estimateTokens('{"pattern":"import"}'))
})

test('estimateUsageFromEvents supports legacy internal event shapes', () => {
  const usage = estimateUsageFromEvents([
    { type: 'agent_message_chunk', data: { content: { text: '旧格式输出' } } },
    { type: 'agent_thought_chunk', data: { text: '思考过程' } },
    { type: 'tool_call', data: { tool_call_id: 't1', raw_input: { file: 'a.py' } } },
    { type: 'tool_call_update', data: { tool_call_id: 't1', raw_output: 'ok' } },
  ])
  assert.ok(usage)
  assert.ok(usage.input_tokens > 0)
  assert.ok(usage.output_tokens > 0)
})

test('estimateUsageFromEvents returns null without any text-bearing events', () => {
  assert.equal(estimateUsageFromEvents([]), null)
  assert.equal(estimateUsageFromEvents([
    { type: 'TOOL_CALL_START', toolCallId: 'c' },
    { type: 'TEXT_MESSAGE_START' },
  ]), null)
  assert.equal(estimateUsageFromEvents(null), null)
})

test('real usage events take precedence and carry no estimated flag', () => {
  const usage = usageFromEvents([
    { type: 'TEXT_MESSAGE_CHUNK', delta: 'streaming text' },
    { type: 'usage_update', data: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
  ])
  assert.equal(usage.total_tokens, 15)
  assert.equal(usage.estimated, undefined)
})
