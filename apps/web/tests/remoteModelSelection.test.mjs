import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/api/client.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
})
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`)

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
