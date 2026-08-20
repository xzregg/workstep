import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { usageFromEvents } from '../src/utils/contextUsage.js'

const processTraceSource = await readFile(
  new URL('../src/components/ProcessTrace.tsx', import.meta.url),
  'utf8',
)

test('token usage reader accepts the unified usage_update events', () => {
  assert.deepEqual(
    usageFromEvents([{ type: 'usage_update', data: { used: 15 } }]),
    { used: 15 },
  )
})

test('process trace backfills legacy durations when ended_at is missing', () => {
  assert.match(processTraceSource, /Math\.min\(\.\.\.eventTimes\)/)
  assert.match(processTraceSource, /startedMs >= Math\.max\(\.\.\.eventTimes\)/)
})
