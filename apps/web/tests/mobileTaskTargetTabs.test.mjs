import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const css = await readFile(new URL('../src/mobile.css', import.meta.url), 'utf8')

test('task chat target tabs scroll horizontally without shrinking their labels', () => {
  assert.match(css, /\.step-target-tabs\s*\{[^}]*overflow-x:\s*auto[^}]*white-space:\s*nowrap/s)
  assert.match(css, /\.step-target-tabs button\s*\{[^}]*flex:\s*0 0 auto/s)
})
