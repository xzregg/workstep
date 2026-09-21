import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyTaskStageMention,
  taskStageMentionQuery,
} from '../src/utils/taskStageMention.ts'

test('detects a task stage mention at the cursor', () => {
  assert.deepEqual(taskStageMentionQuery('@', 1), { start: 0, query: '' })
  assert.deepEqual(taskStageMentionQuery('请交给 @设计', 7), { start: 4, query: '设计' })
  assert.deepEqual(taskStageMentionQuery('第一行\n@开发', 7), { start: 4, query: '开发' })
  assert.equal(taskStageMentionQuery('mail@example.com', 8), null)
  assert.equal(taskStageMentionQuery('@设计 后续', 6), null)
})

test('selecting a task stage consumes only the mention query', () => {
  assert.deepEqual(applyTaskStageMention('请交给 @设计', 7), {
    value: '请交给 ',
    cursor: 4,
  })
  assert.deepEqual(applyTaskStageMention('@开发继续处理', 3), {
    value: '继续处理',
    cursor: 0,
  })
})
