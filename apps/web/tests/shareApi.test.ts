import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, shareApi } from '../src/api/client.ts'

test('loads shared history within the server page limit and preserves chronological order', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const recent = Array.from({ length: 500 }, (_, id) => ({ id: id + 1 }))
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input), 'http://localhost')
    assert.equal(new Headers(options?.headers).get('X-Share-Session'), 'session')
    const limit = Number(url.searchParams.get('limit'))
    if (limit > 500) return Response.json({ detail: [{ msg: 'Input should be less than or equal to 500' }] }, { status: 422 })
    const offset = Number(url.searchParams.get('offset'))
    assert.ok(offset === 0 || offset === 500)
    return Response.json({ messages: offset === 0 ? recent : [{ id: 0 }], limit, offset })
  }
  const result = await shareApi.history('token', 'session')
  assert.deepEqual(result.messages, [{ id: 0 }, ...recent])
})

test('share errors expose readable validation details and HTTP status', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => Response.json({ detail: [
    { loc: ['query', 'limit'], msg: 'Input should be less than or equal to 500' },
  ] }, { status: 422 })
  for (const read of [() => shareApi.meta('token'), () => shareApi.task('token', 'session')]) {
    await assert.rejects(read, (err: unknown) => {
      assert.ok(err instanceof ApiError)
      assert.equal(err.status, 422)
      assert.equal(err.message, 'Input should be less than or equal to 500')
      return true
    })
  }
})

test('shared history respects an explicit limit and offset across pages', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const recent = Array.from({ length: 500 }, (_, id) => ({ id: id + 1 }))
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost')
    requests.push(url.search)
    return Response.json({ messages: requests.length === 1 ? recent : [{ id: 0 }] })
  }
  const result = await shareApi.history('token', 'session', 501, 10)
  assert.deepEqual(requests, ['?limit=500&offset=10', '?limit=1&offset=510'])
  assert.deepEqual(result, { messages: [{ id: 0 }, ...recent], limit: 501, offset: 10 })
})

test('share errors preserve string messages and fall back for non-JSON responses', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => Response.json({ detail: 'Invalid or expired share session' }, { status: 401 })
  await assert.rejects(() => shareApi.task('token', 'session'), {
    name: 'ApiError', status: 401, message: 'Invalid or expired share session',
  })
  globalThis.fetch = async () => new Response('upstream unavailable', { status: 502 })
  await assert.rejects(() => shareApi.task('token', 'session'), {
    name: 'ApiError', status: 502, message: 'HTTP 502',
  })
})
