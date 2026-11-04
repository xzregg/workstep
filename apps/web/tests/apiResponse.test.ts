import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, request, shareRequest } from '../src/api/transport'
import { browserDiagnostics } from '../src/utils/browserDiagnostics'

test('request diagnostics exclude credentials and bodies and ignore deliberate aborts', async (t) => {
  const originalFetch = globalThis.fetch
  browserDiagnostics.clear()
  t.after(() => { globalThis.fetch = originalFetch; browserDiagnostics.clear() })
  globalThis.fetch = async () => Response.json({ detail: 'private-response-body' }, { status: 500 })
  await assert.rejects(request('/projects/private-project/tasks/private-task?token=private-query', {
    method: 'POST', headers: { Authorization: 'Bearer private-auth' }, body: 'private-request-body',
  }), (error: unknown) => { browserDiagnostics.recordError(error); return true })
  const snapshot = JSON.stringify(browserDiagnostics.snapshot())
  assert.match(snapshot, /HTTP 500/)
  for (const value of ['private-response-body', 'private-project', 'private-task', 'private-query', 'private-auth', 'private-request-body']) assert.ok(!snapshot.includes(value), value)
  browserDiagnostics.clear()
  globalThis.fetch = async () => { throw new DOMException('request canceled', 'AbortError') }
  await assert.rejects(request('/events'))
  assert.deepEqual(browserDiagnostics.snapshot(), [])
})

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
