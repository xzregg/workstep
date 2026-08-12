import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterProviderImportCandidates,
  providerImportTabs,
  selectableProviderImportIds,
  toggleProviderImportSelection,
} from '../src/utils/providerImport.ts'

test('select all includes every importable CC Switch application type', () => {
  const ids = selectableProviderImportIds([
    { id: 'codex-1', source_type: 'codex', error: null, already_exists: false },
    { id: 'claude-1', source_type: 'claude', error: null, already_exists: false },
    { id: 'hermes-1', source_type: 'hermes', error: null, already_exists: false },
    { id: 'existing-1', source_type: 'codex', error: null, already_exists: true },
    { id: 'invalid-1', source_type: 'opencode', error: '未找到可导入的 API 地址', already_exists: false },
  ])

  assert.deepEqual(ids, ['codex-1', 'claude-1', 'hermes-1'])
})

test('category tabs show counts and filter candidates by CC Switch application type', () => {
  const candidates = [
    { id: 'codex-1', source_type: 'codex' },
    { id: 'claude-1', source_type: 'claude' },
    { id: 'claude-2', source_type: 'claude' },
    { id: 'openclaw-1', source_type: 'openclaw' },
  ]

  assert.deepEqual(providerImportTabs(candidates, '全部'), [
    { id: 'all', label: '全部', count: 4 },
    { id: 'codex', label: 'Codex', count: 1 },
    { id: 'claude', label: 'Claude Code', count: 2 },
    { id: 'openclaw', label: 'OpenClaw', count: 1 },
  ])
  assert.deepEqual(
    filterProviderImportCandidates(candidates, 'claude').map((item) => item.id),
    ['claude-1', 'claude-2'],
  )
})

test('clicking an import checkbox visibly toggles its selected state once', () => {
  assert.deepEqual(toggleProviderImportSelection([], 'claude-1'), ['claude-1'])
  assert.deepEqual(
    toggleProviderImportSelection(['codex-1', 'claude-1'], 'claude-1'),
    ['codex-1'],
  )
})
