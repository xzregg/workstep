import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')
const agentRules = await readFile(new URL('../../../AGENTS.md', import.meta.url), 'utf8')

test('native checkboxes use the compact global control size', () => {
  assert.match(css, /input\[type="checkbox"\]\s*\{[\s\S]*?width: 16px;[\s\S]*?height: 16px;/)
  assert.match(css, /input\[type="checkbox"\]\s*\{[\s\S]*?flex: 0 0 16px;/)
})

test('frontend guidelines forbid oversized native checkboxes', () => {
  assert.match(agentRules, /\*\*复选框\*\*：原生 `input\[type="checkbox"\]`/)
  assert.match(agentRules, /默认可见尺寸统一为 `16px × 16px`/)
})
