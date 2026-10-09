import assert from 'node:assert/strict'
import test from 'node:test'

import type { Project } from '../src/api/client.ts'
import { useProjectStore } from '../src/stores/projectStore.ts'

const project = (id: string): Project => ({
  id,
  path: `/tmp/${id}`,
  name: id,
  steps: {},
  workflows: [{ id: `${id}-workflow`, name: 'Default', is_default: true, nodeCount: 0 }],
})

test('reorderProjects reorders local state and persists the new order', async () => {
  const first = project('first')
  const second = project('second')
  const third = { ...project('third'), type: 'remote' as const }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), '/api/project/reorder')
    assert.equal(init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(init?.body)), { ordered_ids: ['third', 'first', 'second'] })
    return new Response(JSON.stringify({ reordered: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  useProjectStore.setState({ projects: [first, second, third] })

  try {
    await useProjectStore.getState().reorderProjects(['third', 'first', 'second'])
    assert.deepEqual(
      useProjectStore.getState().projects.map((p) => p.id),
      ['third', 'first', 'second'],
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('reorderProjects refetches when persistence fails', async () => {
  const first = project('first')
  const second = project('second')
  const originalFetch = globalThis.fetch
  let reorderAttempts = 0
  globalThis.fetch = async (input) => {
    if (String(input) === '/api/project/reorder') {
      reorderAttempts += 1
      return new Response(JSON.stringify({ detail: 'nope' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (String(input) === '/api/project/list') {
      return new Response(
        JSON.stringify({ projects: [{ ...first, type: 'local' }, { ...second, type: 'local' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    throw new Error(`unexpected fetch: ${String(input)}`)
  }
  useProjectStore.setState({ projects: [first, second] })

  try {
    await useProjectStore.getState().reorderProjects(['second', 'first'])
    assert.equal(reorderAttempts, 1)
    // Rolled back to the server order after the failed save.
    assert.deepEqual(
      useProjectStore.getState().projects.map((p) => p.id),
      ['first', 'second'],
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
