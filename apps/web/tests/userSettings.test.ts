import assert from 'node:assert/strict'
import test from 'node:test'

import { useUserSettingsStore } from '../src/stores/userSettingsStore.ts'
import { BROWSER_ACTOR_STORAGE_KEY, loadBrowserActor } from '../src/utils/browserActor.ts'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

const resetStore = () => useUserSettingsStore.setState({
  userName: '',
  openMode: false,
  loaded: false,
  loading: false,
  error: '',
})

test('loading user settings does not inherit the host user name into a browser', async () => {
  resetStore()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    assert.equal(String(input), '/api/system-settings')
    return new Response(JSON.stringify({ user_name: '小王', open_mode: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    await useUserSettingsStore.getState().load()
    assert.equal(useUserSettingsStore.getState().userName, '')
    assert.equal(useUserSettingsStore.getState().openMode, true)
    assert.equal(useUserSettingsStore.getState().loaded, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('loading user settings ignores a legacy v1 browser identity', async () => {
  resetStore()
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const storage = memoryStorage()
  storage.setItem('workstep:browser-actor:v1', JSON.stringify({
    id: 'legacy-user',
    name: '旧用户名',
    deviceId: 'legacy-device',
    deviceName: 'Chrome',
  }))
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage },
  })
  globalThis.fetch = async () => new Response(JSON.stringify({ user_name: '', open_mode: false }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

  try {
    await useUserSettingsStore.getState().load()
    assert.equal(useUserSettingsStore.getState().userName, '')
    assert.equal(useUserSettingsStore.getState().deviceId, '')
    assert.equal(useUserSettingsStore.getState().deviceName, '')
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  }
})

test('saving open mode persists through the API', async () => {
  resetStore()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), '/api/system-settings')
    assert.equal(init?.method, 'PUT')
    assert.deepEqual(JSON.parse(String(init?.body)), { open_mode: true })
    return new Response(JSON.stringify({ user_name: '', open_mode: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    assert.equal(await useUserSettingsStore.getState().saveOpenMode(true), true)
    assert.equal(useUserSettingsStore.getState().openMode, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('saving a user name only persists the browser identity', async () => {
  resetStore()
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const storage = memoryStorage()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage },
  })
  globalThis.fetch = async () => {
    throw new Error('browser identity must not update host settings')
  }

  try {
    assert.equal(await useUserSettingsStore.getState().saveUserName('  小王  '), true)
    assert.equal(useUserSettingsStore.getState().userName, '小王')
    assert.equal(JSON.parse(storage.getItem(BROWSER_ACTOR_STORAGE_KEY)!).name, '小王')
    assert.equal(loadBrowserActor(storage)?.name, '小王')
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  }
})

test('a blank user name is rejected without calling the API', async () => {
  useUserSettingsStore.setState({ userName: '小王', loaded: true, loading: false, error: '' })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('blank names must not reach the API')
  }

  try {
    assert.equal(await useUserSettingsStore.getState().saveUserName('   '), false)
    assert.equal(useUserSettingsStore.getState().userName, '小王')
  } finally {
    globalThis.fetch = originalFetch
  }
})


test('desktop persists its name and restores identity after the sandbox origin changes', async () => {
  resetStore()
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  let name = ''
  const settings = () => ({ user_name: name, open_mode: false, device_id: 'sandbox-device', device_name: 'WorkStep' })
  const installWindow = () => Object.defineProperty(globalThis, 'window', {
    configurable: true, value: { localStorage: memoryStorage(), workstepDesktop: { notify() {} } },
  })
  installWindow()
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'PUT') name = JSON.parse(String(init.body)).user_name
    return new Response(JSON.stringify(settings()), { status: 200 })
  }
  try {
    await useUserSettingsStore.getState().load()
    assert.equal(await useUserSettingsStore.getState().saveUserName('  小王  '), true)
    assert.equal(name, '小王')
    const first = loadBrowserActor()!
    installWindow() // A new port has an empty localStorage.
    resetStore()
    await useUserSettingsStore.getState().load()
    assert.equal(useUserSettingsStore.getState().userName, '小王')
    assert.deepEqual(loadBrowserActor(), first)
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  }
})

test('desktop migrates an existing browser name into config', async () => {
  resetStore()
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const storage = memoryStorage()
  storage.setItem(BROWSER_ACTOR_STORAGE_KEY, JSON.stringify({ id: 'old', name: '原名称', deviceId: 'old', deviceName: 'Chrome' }))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage, workstepDesktop: { notify() {} } } })
  let name = ''
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'PUT') name = JSON.parse(String(init.body)).user_name
    return new Response(JSON.stringify({ user_name: name, open_mode: false, device_id: 'desktop', device_name: 'WorkStep' }))
  }
  try {
    await useUserSettingsStore.getState().load()
    assert.equal(name, '原名称')
    assert.equal(useUserSettingsStore.getState().userName, name)
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  }
})


test('desktop prefers the current Home config over an identity from another environment', async () => {
  resetStore()
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  const storage = memoryStorage()
  storage.setItem(BROWSER_ACTOR_STORAGE_KEY, JSON.stringify({ id: 'native', name: '宿主名称', deviceId: 'native', deviceName: 'Chrome' }))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage, workstepDesktop: { notify() {} } } })
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.method, undefined)
    return new Response(JSON.stringify({ user_name: '沙箱名称', open_mode: false, device_id: 'sandbox', device_name: 'WorkStep' }))
  }
  try {
    await useUserSettingsStore.getState().load()
    assert.equal(loadBrowserActor()?.name, '沙箱名称')
    assert.equal(loadBrowserActor()?.id, 'sandbox')
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  }
})

test('desktop reports failed config writes without claiming the name was saved', async () => {
  resetStore()
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: memoryStorage(), workstepDesktop: { notify() {} } } })
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: '配置写入失败' }), { status: 500 })
  try {
    assert.equal(await useUserSettingsStore.getState().saveUserName('小王'), false)
    assert.equal(loadBrowserActor(), null)
    assert.equal(useUserSettingsStore.getState().userName, '')
    assert.ok(useUserSettingsStore.getState().error)
  } finally {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  }
})
