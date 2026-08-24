import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assistantStarterPrompt,
  backfillEmptyTitle,
} from '../src/utils/assistantTitle.ts'


test('opens an assistant without inventing a starter prompt for an empty title', () => {
  assert.equal(assistantStarterPrompt('   ', (title) => `完善“${title}”`), '')
  assert.equal(assistantStarterPrompt('发布流程', (title) => `完善“${title}”`), '完善“发布流程”')
})

test('backfills a generated title only while the user title is empty', () => {
  assert.equal(backfillEmptyTitle('', '  生成的标题  '), '生成的标题')
  assert.equal(backfillEmptyTitle('用户标题', '生成的标题'), '用户标题')
  assert.equal(backfillEmptyTitle('   ', '   '), '   ')
})
