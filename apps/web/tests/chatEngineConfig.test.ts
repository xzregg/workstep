import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearIncompatibleProvider,
  clearChatEngineConfig,
  EMPTY_ENGINE_CONFIG,
  hasChatEngineConfig,
  loadChatEngineConfig,
  saveChatEngineConfig,
  type ChatEngineConfigState,
} from '../src/utils/chatEngineConfig'

const KEY = (projectId: string, sessionId: string) =>
  `workstep-chat-engine-config:${projectId}:${sessionId}`

class MemoryStorage {
  private values = new Map<string, string>()
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, String(value))
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}

function withStorage(storage: MemoryStorage, fn: () => void): void {
  const g = globalThis as Record<string, unknown>
  const previous = g.localStorage
  g.localStorage = storage
  try {
    fn()
  } finally {
    if (previous === undefined) delete g.localStorage
    else g.localStorage = previous
  }
}

test('round-trips a selection per (project, session)', () => {
  const storage = new MemoryStorage()
  withStorage(storage, () => {
    const config: ChatEngineConfigState = {
      engine: 'hermes',
      providerId: 'p-1',
      model: 'model-a',
      fastModel: 'fast-a',
      visionModel: '',
      thinkingEffort: 'high',
    }
    saveChatEngineConfig('proj-1', 'sess-1', config)
    assert.deepEqual(loadChatEngineConfig('proj-1', 'sess-1'), { ...config, providerCleared: false })
    // Other sessions must stay isolated.
    assert.deepEqual(loadChatEngineConfig('proj-1', 'sess-2'), { ...EMPTY_ENGINE_CONFIG })
    assert.deepEqual(loadChatEngineConfig('proj-2', 'sess-1'), { ...EMPTY_ENGINE_CONFIG })
    clearChatEngineConfig('proj-1', 'sess-1')
    assert.deepEqual(loadChatEngineConfig('proj-1', 'sess-1'), { ...EMPTY_ENGINE_CONFIG })
  })
})

test('drops the stored entry once the selection is all empty', () => {
  const storage = new MemoryStorage()
  withStorage(storage, () => {
    saveChatEngineConfig('proj-1', 'sess-1', {
      engine: 'hermes', providerId: '', model: '', fastModel: '', visionModel: '', thinkingEffort: '',
    })
    assert.notEqual(storage.getItem(KEY('proj-1', 'sess-1')), null)
    saveChatEngineConfig('proj-1', 'sess-1', { ...EMPTY_ENGINE_CONFIG })
    assert.equal(storage.getItem(KEY('proj-1', 'sess-1')), null)
    assert.deepEqual(loadChatEngineConfig('proj-1', 'sess-1'), { ...EMPTY_ENGINE_CONFIG })
  })
})

test('ignores corrupted or non-string payloads', () => {
  const storage = new MemoryStorage()
  withStorage(storage, () => {
    storage.setItem(KEY('proj-1', 'sess-1'), '{broken')
    assert.deepEqual(loadChatEngineConfig('proj-1', 'sess-1'), { ...EMPTY_ENGINE_CONFIG })

    storage.setItem(KEY('proj-1', 'sess-1'), JSON.stringify({ engine: 123, model: null }))
    assert.deepEqual(loadChatEngineConfig('proj-1', 'sess-1'), { ...EMPTY_ENGINE_CONFIG })
  })
})

test('missing ids never touch storage and load as empty', () => {
  const storage = new MemoryStorage()
  withStorage(storage, () => {
    saveChatEngineConfig('', 'sess-1', { ...EMPTY_ENGINE_CONFIG, engine: 'hermes' })
    saveChatEngineConfig('proj-1', '', { ...EMPTY_ENGINE_CONFIG, engine: 'hermes' })
    assert.equal(storage.getItem(KEY('', 'sess-1')), null)
    assert.equal(storage.getItem(KEY('proj-1', '')), null)
    assert.deepEqual(loadChatEngineConfig('', 'sess-1'), { ...EMPTY_ENGINE_CONFIG })
  })
})

test('hasChatEngineConfig reflects any non-empty field', () => {
  assert.equal(hasChatEngineConfig(EMPTY_ENGINE_CONFIG), false)
  assert.equal(hasChatEngineConfig({ ...EMPTY_ENGINE_CONFIG, thinkingEffort: 'low' }), true)
  assert.equal(hasChatEngineConfig({ ...EMPTY_ENGINE_CONFIG, providerId: 'p' }), true)
})

test('clears a restored provider that is incompatible with its engine', () => {
  const config = {
    ...EMPTY_ENGINE_CONFIG,
    engine: 'pydantic_ai',
    providerId: 'anthropic',
    model: 'stale-model',
  }
  const sanitized = clearIncompatibleProvider(
    config,
    [{ id: 'pydantic_ai', supports_provider: true, provider_protocols: ['openai_compatible'] }],
    [{ id: 'anthropic', protocol: 'anthropic', enabled: true }],
  )

  assert.equal(sanitized.providerId, '')
  assert.equal(sanitized.engine, 'pydantic_ai')
  assert.equal(sanitized.model, 'stale-model')
})

test('keeps a restored provider when engine and protocol are compatible', () => {
  const config = {
    ...EMPTY_ENGINE_CONFIG,
    engine: 'pydantic_ai',
    providerId: 'openai',
  }
  const sanitized = clearIncompatibleProvider(
    config,
    [{ id: 'pydantic_ai', supports_provider: true, provider_protocols: ['openai_compatible'] }],
    [{ id: 'openai', protocol: 'openai_compatible', enabled: true }],
  )

  assert.equal(sanitized, config)
})

test('does not clear a provider before compatibility data is available', () => {
  const config = {
    ...EMPTY_ENGINE_CONFIG,
    engine: 'pydantic_ai',
    providerId: 'openai',
  }

  assert.equal(clearIncompatibleProvider(config, [], []), config)
  assert.equal(
    clearIncompatibleProvider(
      config,
      [{ id: 'pydantic_ai', supports_provider: true, provider_protocols: ['openai_compatible'] }],
      [],
    ),
    config,
  )
})
