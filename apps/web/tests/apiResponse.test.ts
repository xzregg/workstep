import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, request, shareRequest } from '../src/api/transport'

test('HTML API responses explain the backend mismatch instead of exposing a JSON parser error', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => new Response('<!doctype html><title>WorkStep</title>', {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
  for (const read of [
    () => request('/workflow/generate/history/messages/reply/events?project_id=project'),
    () => shareRequest('/task-share/token/messages/reply/events', 'session'),
  ]) {
    await assert.rejects(read, (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.match(error.message, /接口返回了网页/)
      assert.match(error.message, /后台.*重启/)
      assert.match(error.message, /\/api\//)
      assert.doesNotMatch(error.message, /project_id|Unexpected token/)
      return true
    })
  }
})

test('API JSON responses and validation errors retain their existing behavior', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => Response.json({ events: [], complete: true })
  assert.deepEqual(await request('/events'), { events: [], complete: true })
  globalThis.fetch = async () => Response.json({ detail: [{ msg: '字段不能为空' }] }, { status: 422 })
  await assert.rejects(() => request('/events'), (error: unknown) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 422)
    assert.equal(error.message, '字段不能为空')
    return true
  })
})
