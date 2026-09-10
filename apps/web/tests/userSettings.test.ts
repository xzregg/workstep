import assert from 'node:assert/strict'
import test from 'node:test'

import { useUserSettingsStore } from '../src/stores/userSettingsStore.ts'

const resetStore = () => useUserSettingsStore.setState({
  userName: '',
  openMode: false,
  loaded: false,
  loading: false,
  error: '',
})

test('loading user settings reads the name from config.json through the API', async () => {
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
    assert.equal(useUserSettingsStore.getState().userName, '小王')
    assert.equal(useUserSettingsStore.getState().openMode, true)
    assert.equal(useUserSettingsStore.getState().loaded, true)
  } finally {
    globalThis.fetch = originalFetch
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

test('saving a user name trims it and persists through the API', async () => {
  resetStore()
  const originalFetch = globalThis.fetch
  let requestCount = 0
  globalThis.fetch = async (input, init) => {
    requestCount += 1
    assert.equal(String(input), '/api/system-settings')
    assert.equal(init?.method, 'PUT')
    assert.deepEqual(JSON.parse(String(init?.body)), { user_name: '小王' })
    return new Response(JSON.stringify({ user_name: '小王' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    assert.equal(await useUserSettingsStore.getState().saveUserName('  小王  '), true)
    assert.equal(requestCount, 1)
    assert.equal(useUserSettingsStore.getState().userName, '小王')
  } finally {
    globalThis.fetch = originalFetch
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
