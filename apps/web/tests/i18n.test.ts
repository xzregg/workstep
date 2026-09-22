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

test('uses product-facing engine names', () => {
  for (const dict of Object.values(locales)) {
    const t = createT(dict)
    assert.equal(t('engine.label.codex_sdk'), 'Codex')
    assert.equal(t('engine.label.claude_agent_sdk'), 'Claude Code')
    assert.equal(t('engine.label.claude'), 'Claude Code CLI')
  }
  assert.equal(zhCNT('settings.systemDefault'), '系统默认（Pydantic AI）')
})

test('translates the channel chat assistant name', () => {
  assert.equal(zhCNT('settings.assistantNames.channelChat'), '渠道对话')
  assert.equal(createT(enUS)('settings.assistantNames.channelChat'), 'Channel Chat')
  assert.equal(createT(zhTW)('settings.assistantNames.channelChat'), '渠道對話')
  assert.equal(createT(jaJP)('settings.assistantNames.channelChat'), 'チャンネルチャット')
})

test('uses the concise coordinator name without an Agent suffix', () => {
  assert.equal(zhCNT('aiFlow.agent'), '协调')
  assert.equal(createT(enUS)('aiFlow.agent'), 'Coordinator')
  assert.equal(createT(zhTW)('aiFlow.agent'), '協調')
  assert.equal(createT(jaJP)('aiFlow.agent'), 'コーディネーター')
})

test('uses duration wording for completed and stopped LLM messages', () => {
  assert.equal(zhCNT('trace.processed'), '耗时')
  assert.equal(zhCNT('trace.stoppedAfter', { duration: '3秒' }), '已停止，耗时 3秒')
  assert.equal(
    zhCNT('trace.thoughtCharactersDuration', { count: 12, duration: '3秒' }),
    '思考了 12 Token · 3秒',
  )
})

test('builds the AI workflow draft from the flow name', () => {
  assert.equal(
    zhCNT('layout.aiCreatePrompt', { name: '发布流程' }),
    '帮我创建一个“发布流程”的工作流',
  )
})
