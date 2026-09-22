import assert from 'node:assert/strict'
import test from 'node:test'

import { taskApi } from '../src/api/client.ts'

test('task message detail requests use the unified full-event page size', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost')
    assert.equal(url.pathname, '/api/task/task-1/messages/message-1/events')
    assert.equal(url.searchParams.get('project_id'), 'project-1')
    assert.equal(url.searchParams.get('cursor'), '0')
    assert.equal(url.searchParams.get('limit'), '30000')
    return new Response(JSON.stringify({
      message_id: 'message-1',
      events: [],
      next_cursor: null,
      complete: true,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    await taskApi.messageEvents('task-1', 'message-1', 'project-1')
  } finally {
    globalThis.fetch = originalFetch
  }
})
