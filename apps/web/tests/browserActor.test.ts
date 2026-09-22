import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BROWSER_ACTOR_STORAGE_KEY,
  browserActorHeaders,
  loadBrowserActor,
  saveBrowserActor,
} from '../src/utils/browserActor.ts'
import { taskApi } from '../src/api/client.ts'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

test('browser identity is generated once and reused for API headers', () => {
  const storage = memoryStorage()
  const actor = saveBrowserActor('  小王  ', { deviceId: 'device-1', deviceName: 'Chrome' }, storage)
  assert.deepEqual(actor, {
    id: actor?.id,
    name: '小王',
    deviceId: 'device-1',
    deviceName: 'Chrome',
  })
  assert.deepEqual(loadBrowserActor(storage), actor)
  assert.deepEqual(browserActorHeaders(actor), {
    'X-WorkStep-Actor-Id': encodeURIComponent(actor!.id),
    'X-WorkStep-Actor-Name': encodeURIComponent('小王'),
    'X-WorkStep-Actor-Device-Id': 'device-1',
    'X-WorkStep-Actor-Device-Name': 'Chrome',
  })
  assert.equal(storage.getItem(BROWSER_ACTOR_STORAGE_KEY)?.includes('小王'), true)
})

test('legacy v1 browser identity is ignored', () => {
  const storage = memoryStorage()
  storage.setItem('workstep:browser-actor:v1', JSON.stringify({
    id: 'legacy-user',
    name: '旧用户名',
    deviceId: 'legacy-device',
    deviceName: 'Chrome',
  }))

  assert.equal(loadBrowserActor(storage), null)
  assert.deepEqual(browserActorHeaders(loadBrowserActor(storage)), {})
})

test('task API requests carry the browser identity headers', async () => {
  const storage = memoryStorage()
  const actor = saveBrowserActor('Alice', { deviceId: 'device-1', deviceName: 'Firefox' }, storage)
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage },
  })
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('X-WorkStep-Actor-Id'), actor!.id)
    assert.equal(headers.get('X-WorkStep-Actor-Name'), 'Alice')
    assert.equal(headers.get('X-WorkStep-Actor-Device-Id'), 'device-1')
    assert.equal(headers.get('X-WorkStep-Actor-Device-Name'), 'Firefox')
    return Response.json({
      id: 'task-1', title: 'Task', description: null, cwd: '/tmp', status: 'ready',
      engine: 'codex', created_at: '2026-01-01', updated_at: '2026-01-01', steps: [],
    })
  }
  try {
    await taskApi.create('Task', '/tmp', 'project-1')
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  }
})
