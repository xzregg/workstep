import assert from 'node:assert/strict'
import test from 'node:test'
import { engineApi, fetchEngineModels, invalidateEngineModels } from '../src/api/engine'

test('concurrent model reads share one request and later reads reuse the cache', async () => {
  const original = engineApi.models
  invalidateEngineModels('dedup-test')
  let resolve!: (value: any) => void
  let calls = 0
  engineApi.models = async () => { calls++; return new Promise(done => { resolve = done }) }
  try {
    const first = fetchEngineModels('dedup-test')
    const second = fetchEngineModels('dedup-test')
    assert.equal(calls, 1)
    resolve({ models: [] })
    await Promise.all([first, second])
    await fetchEngineModels('dedup-test')
    assert.equal(calls, 1)
  } finally { engineApi.models = original; invalidateEngineModels('dedup-test') }
})

test('failed model reads can retry without retaining a rejected promise', async () => {
  const original = engineApi.models
  let calls = 0
  engineApi.models = async () => { if (++calls === 1) throw Error('unavailable'); return { models: [] } as any }
  try {
    await assert.rejects(fetchEngineModels('dedup-failure'))
    await fetchEngineModels('dedup-failure')
    assert.equal(calls, 2)
  } finally { engineApi.models = original; invalidateEngineModels('dedup-failure') }
})

test('invalidating in-flight models prevents a stale result replacing the new configuration', async () => {
  const original = engineApi.models
  const pending: Array<(value: any) => void> = []
  engineApi.models = async () => new Promise(resolve => pending.push(resolve))
  try {
    const old = fetchEngineModels('dedup-invalidate')
    invalidateEngineModels('dedup-invalidate')
    const fresh = fetchEngineModels('dedup-invalidate')
    assert.equal(pending.length, 2)
    const latest = { models: [{ id: 'new' }] }
    pending[1](latest)
    await fresh
    pending[0]({ models: [{ id: 'old' }] })
    await old
    assert.deepEqual(await fetchEngineModels('dedup-invalidate'), latest)
  } finally { engineApi.models = original; invalidateEngineModels('dedup-invalidate') }
})


test('repeated explicit refreshes also share the current in-flight request', async () => {
  const original = engineApi.models
  let calls = 0
  let resolve!: (value: any) => void
  engineApi.models = async () => { calls++; return new Promise(done => { resolve = done }) }
  try {
    const first = fetchEngineModels('dedup-refresh', true)
    const second = fetchEngineModels('dedup-refresh', true)
    assert.equal(calls, 1)
    resolve({models:[]})
    await Promise.all([first,second])
  } finally { engineApi.models = original; invalidateEngineModels('dedup-refresh') }
})
