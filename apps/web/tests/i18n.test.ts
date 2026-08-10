import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createT,
  flatten,
  zhCNT,
} from '../src/i18n/index.tsx'
import { zhCN } from '../src/i18n/locales/zh-CN.ts'
import { enUS } from '../src/i18n/locales/en-US.ts'
import { zhTW } from '../src/i18n/locales/zh-TW.ts'
import { jaJP } from '../src/i18n/locales/ja-JP.ts'

const zhKeys = Object.keys(flatten(zhCN)).sort()
const locales = {
  'zh-CN': zhCN,
  'en-US': enUS,
  'zh-TW': zhTW,
  'ja-JP': jaJP,
}

test('all locale dictionaries share identical key sets', () => {
  for (const [name, dict] of Object.entries(locales)) {
    assert.deepEqual(
      Object.keys(flatten(dict)).sort(),
      zhKeys,
      `${name} keys mismatch`,
    )
  }
})

test('all locale dictionaries have no missing or empty values', () => {
  for (const key of zhKeys) {
    for (const [name, dict] of Object.entries(locales)) {
      const value = flatten(dict)[key]
      assert.ok(value !== undefined, `missing value for ${name}.${key}`)
      assert.ok(value.length > 0, `empty value for ${name}.${key}`)
    }
  }
})

test('interpolates {name} placeholders', () => {
  assert.equal(
    zhCNT('taskDetail.artifactNotFound', { name: 'report.md' }),
    '未找到“report.md”对应的产物文件',
  )
  assert.equal(
    createT(enUS)('taskDetail.artifactNotFound', { name: 'report.md' }),
    'No artifact file found for "report.md"',
  )
  assert.equal(
    createT(zhTW)('taskDetail.artifactNotFound', { name: 'report.md' }),
    '未找到“report.md”對應的產物檔案',
  )
  assert.equal(
    createT(jaJP)('taskDetail.artifactNotFound', { name: 'report.md' }),
    '“report.md”に対応する成果物ファイルが見つかりません',
  )
})

test('falls back to zh-CN then the raw key for missing entries', () => {
  const partial = createT({ common: { save: 'Save' } })
  // Missing in the partial dict → falls back to zh-CN.
  assert.equal(partial('common.cancel'), '取消')
  // Missing everywhere → falls back to the raw key.
  assert.equal(partial('no.such.key'), 'no.such.key')
})

test('keeps unknown placeholders as-is when params are missing', () => {
  assert.equal(zhCNT('taskDetail.sendAll'), '全部发送（{count}）')
})
