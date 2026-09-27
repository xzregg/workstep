import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/components/Layout.css', import.meta.url), 'utf8')

test('project sidebar text and icons are scaled down by 20 percent', () => {
  assert.match(css, /\.layout-project-row\s*\{[^}]*font-size: calc\(14px \* var\(--font-scale\)\)/)
  assert.match(css, /\.layout-sidebar-nested-label\s*\{[^}]*font-size: calc\(14px \* var\(--font-scale\)\)/)
  assert.match(source, /name=\{p\.type[\s\S]*?size=\{16\.4\}/)
  assert.match(source, /<Icon name="workflow" size=\{12\.8\}/)
  assert.match(source, /name=\{open \? 'folder-open' : 'folder'\} size=\{14\}/)
  assert.match(css, /\.layout-session-row\s*\{[^}]*cursor: pointer; font-size: calc\(12\.8px \* var\(--font-scale\)\)/)
  assert.match(source, /<Icon name="bot" size=\{11\.6\}/)
})
