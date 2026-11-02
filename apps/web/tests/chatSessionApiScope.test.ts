import assert from 'node:assert/strict'
import test from 'node:test'

import { chatSessionApi } from '../src/api/conversations'

test('chat speed uses native service tier values and omits inherited defaults', async () => {
  const originalFetch = globalThis.fetch
  const bodies: Record<string, unknown>[] = []
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return Response.json({ session_id: 's', turn_id: 't' })
  }
  try {
    for (const tier of ['', 'default', 'priority', 'ultrafast']) {
      await chatSessionApi.chat('s', 'p', 'hi', 'key', { service_tier: tier })
    }
    assert.equal(Object.hasOwn(bodies[0], 'service_tier'), false)
    assert.deepEqual(bodies.slice(1).map(body => body.service_tier), ['default', 'priority', 'ultrafast'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

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
    await chatSessionApi.fork('session-1', {
      project_id: 'project one', title: 'Fork', engine: 'pydantic_ai', context_mode: 'none',
    })
    await chatSessionApi.handoff('session-1', {
      project_id: 'project one', engine: 'pydantic_ai', context_mode: 'none',
    })
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
