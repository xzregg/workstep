import assert from 'node:assert/strict'
import test from 'node:test'

import { chatSessionApi } from '../src/api/conversations'

test('session writes include the bound project in URL and body', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; body: string }> = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body ?? '') })
    return Response.json({ id: 'session-1', turn_id: 'turn-1' })
  }
  try {
    await chatSessionApi.create({ project_id: 'project one' })
    await chatSessionApi.chat('session-1', 'project one', 'hello', 'message-1')
    await chatSessionApi.rename('session-1', 'project one', 'Renamed')
    await chatSessionApi.setArchived('session-1', 'project one', true)
    await chatSessionApi.updatePermissionMode('session-1', 'project one', 'default')
    await chatSessionApi.sendLiveMessage('session-1', 'project one', 'continue')
    await chatSessionApi.saveQuickButtons('project one', [])
    await chatSessionApi.saveSystemPrompt('project one', 'Work here')
    await chatSessionApi.enhancePrompt('project one', 'draft')
    assert.match(calls[0].url, /\/chat-sessions\?project_id=project%20one$/)
    assert.match(calls[1].url, /\/chat-sessions\/session-1\/chat\?project_id=project%20one$/)
    assert.equal(JSON.parse(calls[0].body).project_id, 'project one')
    assert.equal(JSON.parse(calls[1].body).project_id, 'project one')
    for (const call of calls.slice(2)) {
      assert.match(call.url, /\?project_id=project%20one$/)
      assert.equal(JSON.parse(call.body).project_id, 'project one')
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
