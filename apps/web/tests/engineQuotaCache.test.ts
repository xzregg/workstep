import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { engineApi } from '../src/api/engine'

test('quota caches successful reads briefly, isolates projects, expires and allows manual refresh', async () => {
  const { window } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  let clock = 1000000
  let calls = 0
  Date.now = () => clock
  globalThis.fetch = async () => {
    calls++
    return new Response(JSON.stringify({engine_id: 'codex_sdk', supported:true, quota:{engine_id:'codex_sdk'}}), {
      headers:{'Content-Type':'application/json'},
    })
  }
  try {
    await engineApi.quota('codex_sdk', 'cache-project')
    await engineApi.quota('codex_sdk', 'cache-project')
    assert.equal(calls, 1)
    await engineApi.quota('codex_sdk', 'cache-other-project')
    assert.equal(calls, 2)
    await engineApi.quota('codex_sdk', 'cache-project', true)
    assert.equal(calls, 3)
    clock += 31000
    await engineApi.quota('codex_sdk', 'cache-project')
    assert.equal(calls, 4)
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

test('temporary quota failure clears previous cache so the next read can retry', async () => {
  const { window } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => new Response(JSON.stringify(++calls === 2
    ? { engine_id: 'custom', supported: true, status: 'unavailable', quota: null }
    : { engine_id: 'custom', supported: true, status: 'ok', quota: { engine_id: 'custom' } }), {
    headers: { 'Content-Type': 'application/json' },
  })
  try {
    await engineApi.quota('custom', 'retry-project')
    assert.equal((await engineApi.quota('custom', 'retry-project', true)).quota, null)
    await engineApi.quota('custom', 'retry-project')
    assert.equal(calls, 3)
  } finally {
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})
