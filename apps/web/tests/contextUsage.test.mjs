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

test('context usage falls back to total tokens without dropping cached context', () => {
  const context = contextUsageFromMessages([
    {
      events: [{
        type: 'usage_update',
        data: {
          input_tokens: 100,
          output_tokens: 30,
          cache_read_input_tokens: 20,
          total_tokens: 150,
        },
      }],
    },
  ])

  assert.deepEqual(context, { used: 150, total: 200_000, percent: 0.075 })
})

test('context usage falls back to input and output for legacy events', () => {
  const context = contextUsageFromMessages([
    { events: [{ type: 'usage', data: { input_tokens: 10, output_tokens: 5 } }] },
  ])

  assert.deepEqual(context, { used: 15, total: 200_000, percent: 0.0075 })
})
