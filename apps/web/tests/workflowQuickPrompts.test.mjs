import assert from 'node:assert/strict'
import test from 'node:test'

import { applyAssistantQuickPrompt } from '../src/utils/taskQuickPrompts.js'

test('workflow quick prompt appends without replacing the current draft', () => {
  assert.equal(
    applyAssistantQuickPrompt('保留人工审核', '请优化当前流程的阶段依赖。'),
    '保留人工审核\n请优化当前流程的阶段依赖。',
  )
})
