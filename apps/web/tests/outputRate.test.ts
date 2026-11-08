import assert from 'node:assert/strict'
import test from 'node:test'
import { outputRateFromEvents, rateFromSample } from '../src/utils/outputRate'

const start = Date.parse('2026-11-08T00:00:00Z')
const chunk = (seconds: number, delta: string, type = 'TEXT_MESSAGE_CHUNK') => ({
  type, delta, timestamp: start + seconds * 1000,
})
const events = [chunk(0, '首段'), chunk(1, '中文中文'), chunk(2, 'abcdefgh', 'REASONING_MESSAGE_CHUNK')]

test('uses only model text and reasoning deltas, excluding the initial batch', () => {
  assert.equal(outputRateFromEvents(events), 3)
  assert.equal(outputRateFromEvents([...events, { ...chunk(2, 'x'.repeat(4000)), role: 'user' }]), 3)
})
test('tool arguments/results and waiting cannot contribute tokens or time', () => {
  const tool = { type: 'TOOL_CALL_RESULT', output: 'x'.repeat(40000), timestamp: start + 3000 }
  assert.equal(outputRateFromEvents([...events, tool]), 3)
  assert.equal(outputRateFromEvents(events), 3)
  assert.equal(outputRateFromEvents([...events, tool]), 3)
  assert.equal(outputRateFromEvents([...events, tool, chunk(100, 'start'), chunk(101, '中文中文中文')]), 6)
})
test('waiting retains speed and a new tool-delimited segment does not erase it', () => {
  const history = [...events, { type: 'TOOL_CALL_START', timestamp: start + 3000 }, chunk(60, 'single batch')]
  assert.equal(outputRateFromEvents(history), 3)
  assert.equal(outputRateFromEvents(history), 3)
  assert.equal(outputRateFromEvents([chunk(1, 'batch only')]), null)
})
test('uses the current output segment without expiring older samples', () => {
  const stream = Array.from({ length: 11 }, (_, i) => chunk(i, i < 5 ? '中'.repeat(100) : '中'.repeat(10)))
  assert.equal(outputRateFromEvents(stream), 46)
})
test('refresh replays original timestamps and restores a compact final sample', () => {
  assert.equal(outputRateFromEvents(JSON.parse(JSON.stringify(events))), 3)
  assert.equal(outputRateFromEvents(events), 3)
  assert.equal(rateFromSample({ units: 24, elapsed_ms: 2000 }), 3)
  assert.equal(rateFromSample({ units: 24, elapsed_ms: 0 }), null)
  assert.equal(rateFromSample({ units: Infinity, elapsed_ms: 2000 }), null)
})

 test('small ASCII chunks accumulate without per-chunk token rounding', () => {
  const stream = Array.from({ length: 11 }, (_, i) => ({ ...chunk(0, 'a'), timestamp: start + i * 100 }))
  assert.equal(outputRateFromEvents(stream), 3)
})

test('Codex commentary contributes exactly like final text, including replay', () => {
  const stream = [
    chunk(0, '思考', 'REASONING_MESSAGE_CHUNK'),
    { ...chunk(1, '正在核对'), phase: 'commentary', source_item_id: 'progress' },
    { ...chunk(2, '继续验证'), phase: 'commentary', source_item_id: 'progress' },
  ]
  assert.equal(outputRateFromEvents(stream), 4)
  assert.equal(outputRateFromEvents(JSON.parse(JSON.stringify(stream))), 4)
})

test('sparse thinking and sub-second output can produce a stable rate', () => {
  assert.equal(outputRateFromEvents([chunk(0, 'first', 'REASONING_MESSAGE_CHUNK'), chunk(3, '中'.repeat(12), 'REASONING_MESSAGE_CHUNK')]), 4)
  assert.equal(outputRateFromEvents([chunk(0, 'first'), chunk(0.5, '中文')]), 4)
})
