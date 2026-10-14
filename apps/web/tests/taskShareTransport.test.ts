import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { request, registerTaskShareTransport } from '../src/api/transport'

test('task detail operations on a public share use its transport and never fall back to the owner API', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('https://gateway.test/share/token')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('owner API forbidden') }
  const calls: string[] = []
  const cleanup = registerTaskShareTransport('scope', async <T,>(path: string) => {
    calls.push(path)
    if (path.includes('foreign')) throw new Error('scope denied')
    return { title: 'Shared' } as T
  })
  try {
    assert.deepEqual(await request('/task/current/coordinator-config?project_id=share'), { title: 'Shared' })
    await request('/pending-message-inserts', { method: 'POST', body: '{}' })
    await assert.rejects(request('/task/foreign'), /scope denied/)
    assert.equal(calls.length, 3)
  } finally { cleanup(); globalThis.fetch = originalFetch; await window.happyDOM.close() }
})
