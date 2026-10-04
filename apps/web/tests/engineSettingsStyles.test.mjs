import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/EngineSettingsPanel.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/components/EngineSettingsPanel.css', import.meta.url), 'utf8')

test('engine settings fixed appearance lives in CSS and card states use attributes', () => {
  assert.match(css, /\.engine-settings-card\[data-onboarding-compatible="true"\]/)
  assert.match(css, /\.engine-settings-status\[data-state="verified"\]/)
  assert.match(source, /className="engine-settings-card"/)
  assert.match(source, /data-state=\{engine\.verified/)
  assert.equal((source.match(/style=\{/g) || []).length, 1)
})
