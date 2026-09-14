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
  // 事件时间范围已改为单趟扫描 min/max（Math.min(...arr) 大数组展开有爆栈
  // 风险）；回补逻辑本身保留：startedAt 不早于最后事件时用它当终点。
  assert.match(processTraceSource, /minEventMs/)
  assert.match(processTraceSource, /startedMs >= maxEventMs/)
})
