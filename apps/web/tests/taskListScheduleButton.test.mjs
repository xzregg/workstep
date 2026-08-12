import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/pages/TaskList.tsx', import.meta.url), 'utf8')

test('hides the zero schedule count while keeping the schedule button', () => {
  assert.match(source, /scheduleCount > 0 && `\(\$\{scheduleCount\}\)`/)
})
