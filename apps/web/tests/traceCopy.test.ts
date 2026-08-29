import assert from 'node:assert/strict'
import test from 'node:test'

import { zhCN } from '../src/i18n/locales/zh-CN.ts'

test('uses duration wording for completed and stopped LLM messages', () => {
  assert.equal(zhCN.trace.processed, '耗时')
  assert.equal(zhCN.trace.stoppedAfter, '已停止，耗时 {duration}')
})

test('describes collapsed thinking with its character count', () => {
  assert.equal(zhCN.trace.thoughtCharacters, '思考了 {count} 字符')
  assert.equal(
    zhCN.trace.thoughtCharactersDuration,
    '思考了 {count} 字符，{duration}',
  )
})
