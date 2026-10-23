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
import { frFR } from '../src/i18n/locales/fr-FR.ts'
import { deDE } from '../src/i18n/locales/de-DE.ts'
import { ar } from '../src/i18n/locales/ar.ts'
import { builtinLocales } from '../src/i18n/languagePack.ts'
import { resolveInitialLocale, useLocaleStore } from '../src/i18n/index.tsx'

const zhKeys = Object.keys(flatten(zhCN)).sort()
const zhMessages = flatten(zhCN)
const locales = {
  'zh-CN': zhCN,
  'en-US': enUS,
  'zh-TW': zhTW,
  'ja-JP': jaJP,
  'fr-FR': frFR,
  'de-DE': deDE,
  ar,
}

test('detects regional browser variants of the new builtin languages', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  try {
    for (const [language, locale] of [['fr-CA', 'fr-FR'], ['de-AT', 'de-DE'], ['ar-SA', 'ar'], ['ar', 'ar'], ['zh-HK', 'zh-TW'], ['ja-JP', 'ja-JP'], ['es-ES', 'en-US']]) {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language } })
      assert.equal(resolveInitialLocale(), locale)
    }
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
})

test('new builtin languages are selectable and preserve interpolation and placeholders', () => {
  const expected = { 'fr-FR': 'Enregistrer', 'de-DE': 'Speichern', ar: 'حفظ' }
  try {
    for (const [locale, save] of Object.entries(expected)) {
      assert.ok(builtinLocales.includes(locale as typeof builtinLocales[number]))
      useLocaleStore.getState().setLocale(locale)
      assert.equal(useLocaleStore.getState().locale, locale)
      assert.equal(zhCNT('common.save'), save)
      assert.ok(zhCNT('taskDetail.artifactNotFound', { name: 'report.md' }).includes('report.md'))
      for (const [key, value] of Object.entries(flatten(locales[locale]))) {
        assert.deepEqual([...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort(),
          [...zhMessages[key].matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort(), `${locale}: ${key}`)
      }
    }
  } finally { useLocaleStore.getState().setLocale('zh-CN') }
})

test('all locale dictionaries share identical key sets', () => {
  for (const [name, dict] of Object.entries(locales)) {
    assert.deepEqual(
      Object.keys(flatten(dict)).sort(),
      zhKeys,
      `${name} keys mismatch`,
    )
  }
})

test('labels the project directory action consistently', () => {
  assert.equal(zhCNT('taskList.openLocation'), '打开目录')
  assert.equal(createT(enUS)('taskList.openLocation'), 'Open Directory')
  assert.equal(createT(zhTW)('taskList.openLocation'), '開啟目錄')
  assert.equal(createT(jaJP)('taskList.openLocation'), 'ディレクトリを開く')
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

test('task Git repository actions use compact labels', () => {
  assert.equal(zhCNT('git.taskOpenRepositoryDirectory'), '打开目录')
  assert.equal(zhCNT('git.taskRemove'), '移除')
})


test('share clipboard localizes its labels without translating task names or credentials', async () => {
  const { taskShareClipboard } = await import('../../../packages/gateway-ui/src/taskShareDefaults')
  const expected = {
    'zh-CN': '原始任务\n访问地址：https://host/share/token?_t=actual-secret\n访问密码：actual-secret',
    'en-US': '原始任务\nAccess address: https://host/share/token?_t=actual-secret\nAccess password: actual-secret',
    'zh-TW': '原始任务\n存取位址：https://host/share/token?_t=actual-secret\n存取密碼：actual-secret',
    'ja-JP': '原始任务\nアクセス先：https://host/share/token?_t=actual-secret\nアクセスパスワード：actual-secret',
    'fr-FR': '原始任务\nAdresse d’accès : https://host/share/token?_t=actual-secret\nMot de passe : actual-secret',
    'de-DE': '原始任务\nZugriffsadresse: https://host/share/token?_t=actual-secret\nPasswort: actual-secret',
    ar: '原始任务\nعنوان الوصول: https://host/share/token?_t=actual-secret\nكلمة المرور: actual-secret',
  }
  for (const [locale, dict] of Object.entries(locales)) {
    const t = createT(dict)
    assert.equal(taskShareClipboard('https://host/share/token', 'actual-secret', '原始任务', {
      address: t('share.copyAddress'), password: t('share.copyPassword'), task: t('share.copyTask'),
    }), expected[locale as keyof typeof expected])
  }
})
