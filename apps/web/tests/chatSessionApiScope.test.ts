import assert from 'node:assert/strict'
import test from 'node:test'

import { chatSessionApi } from '../src/api/conversations'

test('session creation and chat include the bound project in URL and body', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; body: string }> = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body ?? '') })
    return Response.json({ id: 'session-1', turn_id: 'turn-1' })
  }
  try {
    await chatSessionApi.create({ project_id: 'project one' })
    await chatSessionApi.chat('session-1', 'project one', 'hello', 'message-1')
    assert.match(calls[0].url, /\/chat-sessions\?project_id=project%20one$/)
    assert.match(calls[1].url, /\/chat-sessions\/session-1\/chat\?project_id=project%20one$/)
    assert.equal(JSON.parse(calls[0].body).project_id, 'project one')
    assert.equal(JSON.parse(calls[1].body).project_id, 'project one')
  } finally {
    globalThis.fetch = originalFetch
  }
})
