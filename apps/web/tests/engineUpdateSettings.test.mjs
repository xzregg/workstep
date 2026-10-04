import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const settings = await readFile(new URL('../src/components/EngineSettingsPanel.tsx', import.meta.url), 'utf8')
test('settings assembles the self-managed runtime control for supported engines', () => {
  assert.match(settings, /engine\.runtime_manageable/)
  assert.match(settings, /<EngineRuntimeControl[\s\S]*?engineId=\{engine\.id\}/)
  assert.ok(
    settings.indexOf('<EngineRuntimeControl') < settings.indexOf("t('settings.test')"),
    '安装与版本按钮应位于测试按钮左侧',
  )
  assert.doesNotMatch(settings, /const (installEngine|updateEngine) =/)
})
