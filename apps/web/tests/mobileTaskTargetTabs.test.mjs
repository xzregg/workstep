import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const css = await readFile(new URL('../src/mobile.css', import.meta.url), 'utf8')

test('mobile task conversation hides the heading and current step row', () => {
  assert.match(css, /@media\s*\(max-width:\s*1023px\)[\s\S]*\.task-conversation-header\s*\{\s*display:\s*none;\s*\}/)
})

test('task chat target tabs scroll horizontally without shrinking their labels', () => {
  assert.match(css, /\.step-target-tabs\s*\{[^}]*overflow-x:\s*auto[^}]*white-space:\s*nowrap/s)
  assert.match(css, /\.step-target-tabs button\s*\{[^}]*flex:\s*0 0 auto/s)
})
