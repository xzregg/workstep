import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const page = await readFile(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/pages/SettingsPage.css', import.meta.url), 'utf8')

test('settings page keeps fixed presentation in named CSS selectors', () => {
  assert.doesNotMatch(page, /\bstyle=\{\{/)
  assert.match(page, /className="modal settings-dialog-panel"/)
  assert.match(page, /className="settings-system-page"/)
  assert.match(css, /\.modal\.settings-dialog-panel\s*\{/)
  assert.match(css, /\.settings-system-page\s*\{/)
})
