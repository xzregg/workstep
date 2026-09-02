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
