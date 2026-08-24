import test from 'node:test'
import assert from 'node:assert/strict'

import {
  engineDescription,
  engineLabel,
  ENGINE_COLORS,
  sortExecutionEngines,
} from '../src/engineMeta.ts'
import { engineOptionLabel, isEngineSelectable } from '../src/components/EngineSelect.tsx'
import { zhCNT } from '../src/i18n/index.tsx'

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

test('engine dropdown labels omit transport types', () => {
  assert.equal(engineOptionLabel({
    id: 'codex_sdk',
    installed: true,
    configured: true,
    verified: true,
    built_in: false,
    mode: 'sdk',
  }, false, zhCNT), 'Codex')
})

test('settings prioritize the four primary execution engines', () => {
  const engines = [
    { id: 'pydantic_ai', installed: true },
    { id: 'codex', installed: true },
    { id: 'claude', installed: true },
    { id: 'codex_sdk', installed: true },
    { id: 'claude_agent_sdk', installed: true },
    { id: 'hermes', installed: true },
  ]

  assert.deepEqual(sortExecutionEngines(engines).map((engine) => engine.id), [
    'pydantic_ai',
    'claude_agent_sdk',
    'codex_sdk',
    'claude',
    'codex',
    'hermes',
  ])
})
