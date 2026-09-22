import assert from 'node:assert/strict'
import test from 'node:test'

const api = await import('../src/api/client.ts')

test('remote conversation model configuration is read through the remote project', async () => {
  const originalFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    urls.push(url)
    if (url.startsWith('/api/engine/coordinator/config')) {
      return Response.json({ engine: 'codex', available_engines: [] })
    }
    if (url.startsWith('/api/provider/list')) {
      return Response.json({ providers: [], types: [] })
    }
    return Response.json({
      engine_id: 'codex',
      models: [{ id: 'gpt-5', label: 'GPT-5', description: null }],
      default_model: 'gpt-5',
      error: null,
    })
  }

  try {
    const projectId = 'remote:conversation-models'
    await api.engineApi.coordinatorDefaults(projectId)
    await api.providerApi.list(projectId)
    const result = await api.fetchEngineModels('codex', false, '', projectId)

    assert.equal(result.models[0]?.id, 'gpt-5')
    assert.deepEqual(urls, [
      '/api/engine/coordinator/config?project_id=remote%3Aconversation-models',
      '/api/provider/list?project_id=remote%3Aconversation-models',
      '/api/engine/codex/models?project_id=remote%3Aconversation-models',
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})
