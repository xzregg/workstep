import assert from 'node:assert/strict'
import test from 'node:test'
import { useManagedModeStore } from '../src/stores/managedModeStore'

test('managed mode is loaded once for all legacy share entry points', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async input => {
    assert.equal(String(input), '/api/managed/mode')
    calls++
    return Response.json({ managed: true })
  }
  try {
    useManagedModeStore.setState({ managed: null, loading: false })
    await Promise.all([
      useManagedModeStore.getState().load(),
      useManagedModeStore.getState().load(),
    ])
    assert.equal(useManagedModeStore.getState().managed, true)
    await useManagedModeStore.getState().load()
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
    useManagedModeStore.setState({ managed: null, loading: false })
  }
})
