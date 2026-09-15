import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const settings = await readFile(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8')
test('settings assembles the self-managed runtime control for supported engines', () => {
  assert.match(settings, /engine\.runtime_manageable/)
  assert.match(settings, /<EngineRuntimeControl[\s\S]*?engineId=\{engine\.id\}/)
  assert.doesNotMatch(settings, /const (installEngine|updateEngine) =/)
})
