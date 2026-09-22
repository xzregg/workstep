import assert from 'node:assert/strict'
import test from 'node:test'

import { contextUsageFromMessages } from '../src/utils/contextUsage.js'

test('context usage prefers the latest canonical used and size snapshot', () => {
  const context = contextUsageFromMessages([
    { events: [{ type: 'CUSTOM', name: 'workstep.usage', value: { used: 10, size: 100 } }] },
    { events: [{ type: 'CUSTOM', name: 'workstep.usage', value: { used: 60, size: 200 } }] },
  ])

  assert.deepEqual(context, { used: 60, total: 200, percent: 30 })
})

test('context usage ignores cumulative run usage without a context window snapshot', () => {
  const context = contextUsageFromMessages([
    {
      events: [{
        type: 'usage_update',
        data: {
          input_tokens: 280_782,
          output_tokens: 1_978,
          total_tokens: 282_760,
          cache_read_input_tokens: 235_520,
          requests: 12,
        },
      }],
    },
  ])

  assert.equal(context, null)
})

test('context usage ignores an impossible persisted snapshot above its window', () => {
  const context = contextUsageFromMessages([
    {
      events: [{
        type: 'usage_update',
        data: {
          used: 2_277_214,
          size: 256_000,
          input_tokens: 2_206,
          output_tokens: 872,
          cache_read_input_tokens: 2_272_795,
        },
      }],
    },
  ])

  assert.equal(context, null)
})

test('context usage uses total tokens when an explicit context window is present', () => {
  const context = contextUsageFromMessages([
    {
      events: [{
        type: 'usage_update',
        data: {
          input_tokens: 100,
          output_tokens: 30,
          cache_read_input_tokens: 20,
          total_tokens: 150,
          size: 200_000,
        },
      }],
    },
  ])

  assert.deepEqual(context, { used: 150, total: 200_000, percent: 0.075 })
})

test('context usage accepts legacy token fields with an explicit context window', () => {
  const context = contextUsageFromMessages([
    {
      events: [{
        type: 'usage',
        data: { input_tokens: 10, output_tokens: 5, context_window: 200_000 },
      }],
    },
  ])

  assert.deepEqual(context, { used: 15, total: 200_000, percent: 0.0075 })
})

test('context usage exposes an estimated visible-event breakdown and tool top list', () => {
  const context = contextUsageFromMessages([
    {
      events: [
        { type: 'TEXT_MESSAGE_CHUNK', role: 'user', delta: '请读取文件' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'a', toolCallName: 'read_file', args: { path: 'README.md' } },
        { type: 'TOOL_CALL_RESULT', toolCallId: 'a', toolCallName: 'read_file', output: '项目说明内容' },
        { type: 'TEXT_MESSAGE_CHUNK', role: 'assistant', delta: '已经读取完成' },
        { type: 'CUSTOM', name: 'workstep.usage', value: { used: 80, size: 1_000 } },
      ],
    },
  ])

  assert.equal(context.breakdown.estimated, true)
  assert.ok(context.breakdown.user > 0)
  assert.ok(context.breakdown.assistant > 0)
  assert.ok(context.breakdown.toolRequests > 0)
  assert.ok(context.breakdown.toolResults > 0)
  assert.equal(context.breakdown.other, 80 - context.breakdown.visible)
  assert.equal(context.tools[0].name, 'read_file')
  assert.equal(context.tools[0].tokens, context.breakdown.toolRequests + context.breakdown.toolResults)
})

test('context usage prefers an engine-reported context breakdown', () => {
  const context = contextUsageFromMessages([{ events: [{
    type: 'usage_update',
    data: {
      used: 50,
      size: 500,
      context_breakdown: {
        system: 10,
        tool_definitions: 8,
        user_messages: 12,
        assistant_messages: 20,
      },
      context_tools: [{ name: 'read_file', tokens: 8 }],
    },
  }] }])

  assert.equal(context.breakdown.estimated, false)
  assert.equal(context.breakdown.system, 10)
  assert.equal(context.breakdown.toolDefinitions, 8)
  assert.deepEqual(context.tools, [{ name: 'read_file', tokens: 8 }])
})

test('context usage estimates events received after the latest usage snapshot', () => {
  const context = contextUsageFromMessages([
    { events: [{ type: 'CUSTOM', name: 'workstep.usage', value: { used: 100, size: 1_000 } }] },
    { events: [
      { type: 'TEXT_MESSAGE_CHUNK', role: 'assistant', delta: '正在生成' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'a', toolCallName: 'read_file', args: '文件' },
      { type: 'TOOL_CALL_RESULT', toolCallId: 'a', toolCallName: 'read_file', output: '结果' },
    ] },
  ])

  assert.equal(context.used, 108)
  assert.equal(context.percent, 10.8)
  assert.equal(context.estimated, true)
})

test('context usage does not estimate events already covered by the final snapshot', () => {
  const context = contextUsageFromMessages([{ events: [
    { type: 'TEXT_MESSAGE_CHUNK', role: 'assistant', delta: '已经完成' },
    { type: 'CUSTOM', name: 'workstep.usage', value: { used: 120, size: 1_000 } },
  ] }])

  assert.equal(context.used, 120)
  assert.equal(context.estimated, undefined)
})
