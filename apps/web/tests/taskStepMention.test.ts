import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyTaskStepMention,
  taskStepMentionQuery,
} from '../src/utils/taskStepMention.ts'

test('detects a task step mention at the cursor', () => {
  assert.deepEqual(taskStepMentionQuery('@', 1), { start: 0, query: '' })
  assert.deepEqual(taskStepMentionQuery('请交给 @设计', 7), { start: 4, query: '设计' })
  assert.deepEqual(taskStepMentionQuery('第一行\n@开发', 7), { start: 4, query: '开发' })
  assert.equal(taskStepMentionQuery('mail@example.com', 8), null)
  assert.equal(taskStepMentionQuery('@设计 后续', 6), null)
})

test('selecting a task step consumes only the mention query', () => {
  assert.deepEqual(applyTaskStepMention('请交给 @设计', 7), {
    value: '请交给 ',
    cursor: 4,
  })
  assert.deepEqual(applyTaskStepMention('@开发继续处理', 3), {
    value: '继续处理',
    cursor: 0,
  })
})
