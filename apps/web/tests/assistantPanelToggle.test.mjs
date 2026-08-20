import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const taskListSource = await readFile(new URL('../src/pages/TaskList.tsx', import.meta.url), 'utf8')
const layoutSource = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')
const scheduleSource = await readFile(new URL('../src/pages/SchedulePage.tsx', import.meta.url), 'utf8')

test('task assistant button toggles its embedded conversation', () => {
  assert.match(taskListSource, /aria-expanded=\{taskAiOpen\}/)
  assert.match(taskListSource, /if \(taskAiOpen\) \{\s*requestCloseTaskAi\(\)\s*return\s*\}/)
})

test('new-workflow assistant button toggles its embedded conversation', () => {
  assert.match(layoutSource, /aria-expanded=\{addWfAiOpen\}/)
  assert.match(layoutSource, /if \(addWfAiOpen\) \{\s*requestCloseAddWfAi\(\)\s*return\s*\}/)
})

test('schedule test assistant button toggles its embedded conversation', () => {
  assert.match(scheduleSource, /aria-expanded=\{testOpen\}/)
  assert.match(scheduleSource, /onClick=\{toggleTestAssistant\}/)
})
