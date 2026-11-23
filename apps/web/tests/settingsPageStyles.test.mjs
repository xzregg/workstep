import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const page = await readFile(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/pages/SettingsPage.css', import.meta.url), 'utf8')
const project = await readFile(new URL('../src/components/ProjectSettingsPanel.tsx', import.meta.url), 'utf8')

test('settings page keeps fixed presentation in named CSS selectors', () => {
  assert.doesNotMatch(page, /\bstyle=\{\{/)
  assert.match(page, /className=(?:"|\{`)modal settings-dialog-panel/)
  assert.match(page, /className="settings-system-page"/)
  assert.match(css, /\.modal\.settings-dialog-panel\s*\{/)
  assert.match(css, /\.settings-system-page\s*\{/)
})

test('project configuration reuses the settings dialog dimensions', () => {
  assert.match(project, /className="modal-overlay settings-dialog-overlay"/)
  assert.match(project, /className="modal settings-dialog-panel"/)
  assert.match(project, /import ['"].*SettingsPage\.css['"]/)
  assert.doesNotMatch(project, /width: 860|height: '78vh'/)
})
