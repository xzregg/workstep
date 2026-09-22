import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const taskListSource = readFileSync(new URL('../src/pages/TaskList.tsx', import.meta.url), 'utf8')

test('断点续跑标签显示在任务状态左侧', () => {
  const recoveredBadge = taskListSource.indexOf('task-card-recovered-badge')
  const statusBadge = taskListSource.indexOf('task-card-status-badge')

  assert.notEqual(recoveredBadge, -1)
  assert.notEqual(statusBadge, -1)
  assert.ok(recoveredBadge < statusBadge)
})
