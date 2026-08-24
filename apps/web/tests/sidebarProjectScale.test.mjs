import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')

test('project sidebar text and icons are scaled down by 20 percent', () => {
  assert.match(source, /const projectItemStyle[\s\S]*?fontSize: 14,/)
  assert.match(source, /const nestedSectionLabel[\s\S]*?fontSize: 14,/)
  assert.match(source, /name=\{p\.type[\s\S]*?size=\{16\.4\}/)
  assert.match(source, /<Icon name="workflow" size=\{12\.8\}/)
  assert.match(source, /name=\{open \? 'folder-open' : 'folder'\} size=\{14\}/)
  assert.match(source, /cursor: 'pointer', fontSize: 12\.8,/)
  assert.match(source, /<Icon name="bot" size=\{11\.6\}/)
})
