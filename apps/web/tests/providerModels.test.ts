import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeProviderProtocolModels } from '../src/utils/providerModels.ts'

test('provider models stay grouped by protocol while the total is deduplicated', () => {
  const summary = summarizeProviderProtocolModels([
    {
      protocol: 'anthropic_messages',
      models: [
        { id: 'shared', label: 'Shared from Anthropic' },
        { id: 'claude-only', label: 'Claude only' },
      ],
      fetchedAt: '2026-09-21T10:00:00+00:00',
    },
    {
      protocol: 'openai_responses',
      models: [
        { id: 'shared', label: 'Shared from OpenAI' },
        { id: 'gpt-only', label: 'GPT only' },
        { id: 'other', label: 'Other' },
      ],
      fetchedAt: '2026-09-21T10:01:00+00:00',
    },
  ])

  assert.equal(summary.uniqueCount, 4)
  assert.equal(summary.latestFetchedAt, '2026-09-21T10:01:00+00:00')
  assert.deepEqual(summary.groups.map((group) => ({
    protocol: group.protocol,
    ids: group.models.map((model) => model.id),
  })), [
    { protocol: 'anthropic_messages', ids: ['shared', 'claude-only'] },
    { protocol: 'openai_responses', ids: ['shared', 'gpt-only', 'other'] },
  ])
})

test('duplicate models inside one protocol are collapsed without mixing protocols', () => {
  const summary = summarizeProviderProtocolModels([
    {
      protocol: 'anthropic_messages',
      models: [
        { id: 'claude', label: 'Old label' },
        { id: 'claude', label: 'New label' },
      ],
      fetchedAt: null,
    },
    {
      protocol: 'openai_chat_completions',
      models: [{ id: 'claude', label: 'Gateway label' }],
      fetchedAt: null,
    },
  ])

  assert.equal(summary.uniqueCount, 1)
  assert.equal(summary.groups[0]?.models.length, 1)
  assert.equal(summary.groups[0]?.models[0]?.label, 'New label')
  assert.equal(summary.groups[1]?.models[0]?.label, 'Gateway label')
})
