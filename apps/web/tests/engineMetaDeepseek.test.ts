import test from 'node:test'
import assert from 'node:assert/strict'

import { engineDescription, engineLabel, ENGINE_COLORS } from '../src/engineMeta.ts'
import { isEngineSelectable } from '../src/components/EngineSelect.tsx'

test('DeepSeek Harness has localized engine metadata', () => {
  assert.equal(engineLabel('deepseek_harness'), 'DeepSeek Harness')
  assert.match(engineDescription('deepseek_harness'), /官方 Harness SDK/)
  assert.match(ENGINE_COLORS.deepseek_harness, /^#[0-9a-f]{6}$/i)
})

test('DeepSeek Harness remains selectable in assistant and chat coordinator pickers', () => {
  assert.equal(isEngineSelectable({
    id: 'deepseek_harness',
    installed: true,
    configured: true,
    verified: true,
    built_in: false,
    mode: 'sdk',
    supports_coordinator: true,
  }, true), true)
})
