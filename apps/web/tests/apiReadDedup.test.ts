import assert from 'node:assert/strict'
import test from 'node:test'

import { shareApi, workflowApi } from '../src/api/client.ts'

const workflowResponse = {
  id: 'e3606e86',
  name: 'test',
  steps: { nodes: [], connections: [] },
  is_default: false,
  created_at: '',
  updated_at: '',
}

test('deduplicates concurrent workflow detail reads', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  let calls = 0
  let resolveResponse!: (response: Response) => void
  globalThis.fetch = async () => {
    calls += 1
    return new Promise<Response>((resolve) => { resolveResponse = resolve })
  }

  const first = workflowApi.get('e3606e86', '164938b7')
  const second = workflowApi.get('e3606e86', '164938b7')

  assert.equal(calls, 1)
  resolveResponse(Response.json(workflowResponse))
  assert.deepEqual(await Promise.all([first, second]), [workflowResponse, workflowResponse])
})

test('starts a fresh read after the previous request settles', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return Response.json(workflowResponse)
  }

  await workflowApi.get('e3606e86', '164938b7')
  await workflowApi.get('e3606e86', '164938b7')

  assert.equal(calls, 2)
})

test('deduplicates authenticated public-share reads', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  let calls = 0
  let resolveResponse!: (response: Response) => void
  globalThis.fetch = async () => {
    calls += 1
    return new Promise<Response>((resolve) => { resolveResponse = resolve })
  }

  const first = shareApi.artifacts('share-token', 'session-token')
  const second = shareApi.artifacts('share-token', 'session-token')

  assert.equal(calls, 1)
  resolveResponse(Response.json({ artifacts: [] }))
  await Promise.all([first, second])
})

test('does not deduplicate concurrent writes', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return Response.json(workflowResponse)
  }

  await Promise.all([
    workflowApi.update('e3606e86', '164938b7', 'first'),
    workflowApi.update('e3606e86', '164938b7', 'second'),
  ])

  assert.equal(calls, 2)
})
