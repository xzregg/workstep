import test from 'node:test'
import assert from 'node:assert/strict'
import { engineLabel, engineDescription } from '../src/engineMeta.ts'
import { isEngineSelectable } from '../src/components/EngineSelect.tsx'

test('Antigravity is named and selectable only after installation and verification', () => {
  assert.equal(engineLabel('antigravity'), 'Antigravity')
  assert.match(engineDescription('antigravity'), /本机登录/)
  const engine = { id: 'antigravity', installed: true, configured: true, verified: true, enabled: true }
  assert.equal(isEngineSelectable(engine), true)
  assert.equal(isEngineSelectable({ ...engine, installed: false }), false)
  assert.equal(isEngineSelectable({ ...engine, verified: false }), false)
})

test('Antigravity clearly identifies native sign-in and settings', () => {
  assert.equal(engineLabel('antigravity'), 'Antigravity')
  assert.match(engineDescription('antigravity'), /本机登录/)
})
