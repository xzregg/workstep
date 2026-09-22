import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(
  new URL('../src/pages/SharedTaskView.tsx', import.meta.url),
  'utf8',
)

test('shared task live events are capped before entering message state', () => {
  assert.match(source, /appendCappedSharedEvent/)
  assert.match(source, /MAX_LIVE_SHARED_EVENTS\s*=\s*2000/)
})

test('shared task history events are capped before entering message state', () => {
  assert.match(source, /capSharedHistoryEvents/)
  assert.match(source, /historyData\.messages\.map\(capSharedHistoryEvents\)/)
})
