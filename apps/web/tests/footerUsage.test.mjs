import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const footerSource = await readFile(
  new URL('../src/components/MessageResponseFooter.tsx', import.meta.url),
  'utf8',
)
const processTraceSource = await readFile(
  new URL('../src/components/ProcessTrace.tsx', import.meta.url),
  'utf8',
)

test('token usage reader accepts the unified usage_update events', () => {
  assert.match(
    footerSource,
    /event\?\.type === 'usage' \|\| event\?\.type === 'usage_update'/,
  )
})

test('process trace backfills legacy durations when ended_at is missing', () => {
  assert.match(processTraceSource, /Math\.min\(\.\.\.eventTimes\)/)
  assert.match(processTraceSource, /startedMs >= Math\.max\(\.\.\.eventTimes\)/)
})
