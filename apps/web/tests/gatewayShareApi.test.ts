import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gatewayShareApi } from '../src/api/gatewayShare'

test('Gateway share transport uses visitor cookies and CSRF instead of local share credentials', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    if (String(input).endsWith('/session')) return new Response(null, { status: 401 })
    return Response.json(String(input).endsWith('/unlock') ? { csrf_token: 'visitor-csrf' } : {})
  }
  try {
    assert.deepEqual(await gatewayShareApi.unlock('handle', ''), { session_token: 'visitor-csrf' })
    await gatewayShareApi.sendStepMessage('handle', 'visitor-csrf', 'task', 'step', 'hello')
    assert.equal(calls[1].url, '/api/public/shares/handle/steps/step/message')
    assert.equal(new Headers(calls[1].init?.headers).get('X-Share-CSRF'), 'visitor-csrf')
    assert.equal(new Headers(calls[1].init?.headers).get('X-Share-Session'), null)
    assert.equal(calls[1].init?.credentials, 'same-origin')
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { content: 'hello' })
    assert.equal(gatewayShareApi.buildWsUrl('visitor-csrf'), null)
    await assert.rejects(gatewayShareApi.gitRequest('handle', 'visitor-csrf', '/api/admin/providers'))
  } finally { globalThis.fetch = original }
})

test('Gateway Git read transport maps bounded task reads and virtual files to explicit public endpoints', async () => {
  const calls: string[] = []; const original = globalThis.fetch
  globalThis.fetch = async input => { calls.push(String(input)); return Response.json({}) }
  try {
    await gatewayShareApi.gitRequest('handle', 'csrf', '/git/repositories')
    await gatewayShareApi.gitRequest('handle', 'csrf', '/git/worktrees/' + 'a'.repeat(24) + '/history?offset=0')
    await gatewayShareApi.previewFile('handle', 'csrf', 'workspace:app/README.md')
    assert.ok(calls[0].includes('/git/read/repositories/'))
    assert.ok(calls[1].includes('/git/read/history/'))
    assert.ok(calls[2].includes('/git/read/preview/'))
    await assert.rejects(gatewayShareApi.gitRequest('handle', 'csrf', '/git/worktrees/' + 'a'.repeat(24) + '/history?user_id=owner'))
  } finally { globalThis.fetch = original }
})
