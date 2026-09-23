import assert from 'node:assert/strict'
import test from 'node:test'

import { taskApi } from '../src/api/client'

test('reset-step selection is sent with the resumed step message', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  let body: unknown
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body || '{}'))
    return Response.json({
      message_id: 'message-1',
      step_key: 'build',
      run_id: 'run-1',
      status: 'queued',
    })
  }

  await taskApi.resumeStepWithMessage(
    'task-1',
    'build',
    '重新执行',
    'project-1',
    true,
  )

  assert.deepEqual(body, { content: '重新执行', reset_step: true })
})
