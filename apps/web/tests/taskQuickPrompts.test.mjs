import assert from 'node:assert/strict'
import test from 'node:test'

import { applyTaskQuickPrompt } from '../src/utils/taskQuickPrompts.js'

test('task quick prompt fills an empty chat input', () => {
  assert.equal(
    applyTaskQuickPrompt('', '补充任务的验收标准'),
    '补充任务的验收标准',
  )
})

test('task quick prompt appends to an existing draft without replacing it', () => {
  assert.equal(
    applyTaskQuickPrompt('需要兼容移动端', '补充任务的验收标准'),
    '需要兼容移动端\n补充任务的验收标准',
  )
})

test('task quick prompt ignores whitespace around the existing draft', () => {
  assert.equal(
    applyTaskQuickPrompt('   ', '分析风险与边界'),
    '分析风险与边界',
  )
})
