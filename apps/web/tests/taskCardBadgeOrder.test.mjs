import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const taskListSource = readFileSync(new URL('../src/pages/TaskList.tsx', import.meta.url), 'utf8')

test('任务列表使用独立任务卡片呈现状态', () => {
  assert.match(taskListSource, /<TaskBoardCard/)
})
