import assert from 'node:assert/strict'
import test from 'node:test'
import { createGatewayTaskShareApi } from '../src/api/gatewayTaskShare'

test('gateway modal creates and revokes on the workspace, preserving retries and expiry', async () => {
  const originalFetch = globalThis.fetch
  const calls: { url: string; init?: RequestInit }[] = []
  let failRevoke = true
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.includes('?')) return Response.json({ shares: [] })
    if (url.endsWith('/revoke')) {
      if (failRevoke) { failRevoke = false; return Response.json({ detail: 'Try again' }, { status: 503 }) }
      return new Response(null, { status: 204 })
    }
    return Response.json({ id: 'share-1', url: 'https://gateway.example/share/token', status: 'active', mode: 'interactive', title: 'Demo', created_at: '2026-10-10T00:00:00Z' })
  }
  try {
    const api = createGatewayTaskShareApi('platform-1')
    assert.equal(await api.get('task-1', 'host-1'), null)
    const created = await api.create('task-1', 'host-1', 'pass', 'Demo', 'interactive', '2026-10-15T00:00:00Z')
    assert.equal(created.url, 'https://gateway.example/share/token')
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { project_id: 'platform-1', task_id: 'task-1', password: 'pass', title: 'Demo', mode: 'interactive', expires_at: '2026-10-15T00:00:00Z' })
    assert.equal((calls[1].init?.headers as Record<string, string>)['X-WorkStep-Share-Intent'], 'manage')
    await assert.rejects(api.revoke('task-1', 'host-1'), /Try again/)
    await api.revoke('task-1', 'host-1')
    assert.equal(calls[3].url, '/api/remote/task-shares/share-1/revoke')
  } finally { globalThis.fetch = originalFetch }
})
