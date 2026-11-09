import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { speechApi } from '../src/api/speech'

test('release while creation is pending cleans up only that late session', async () => {
  const { window } = installDomEnvironment()
  const original = globalThis.fetch
  const controller = new AbortController()
  const calls: string[] = []
  let accept!: () => void
  let created!: () => void
  const creating = new Promise<void>(done => { created = done })
  const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
  globalThis.fetch = async (url, options) => {
    const method = options?.method || 'GET'
    calls.push(`${method} ${url}`)
    if (method === 'DELETE') return response({ cancelled: true })
    if (calls.length === 1) {
      created()
      await new Promise<void>(done => { accept = done })
      if (options?.signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
      return response({ id: 'old', sample_rate: 16000, max_seconds: 120 })
    }
    return response({ id: 'new', sample_rate: 16000, max_seconds: 120 })
  }
  try {
    const pending = speechApi.start('p', controller.signal)
    const rejected = assert.rejects(pending, { name: 'AbortError' })
    await creating
    controller.abort()
    const next = speechApi.start('p')
    accept()
    await rejected
    assert.equal((await next).id, 'new')
    assert.equal(calls.filter(call => call === 'POST /api/speech/sessions?project_id=p').length, 2)
    assert.ok(calls.includes('DELETE /api/speech/sessions/old?project_id=p'))
  } finally { globalThis.fetch = original; await window.happyDOM.close() }
})

test('a pending cancellation does not block another recording', async () => {
  const { window } = installDomEnvironment()
  const original = globalThis.fetch
  let release!: () => void
  let entered!: () => void
  const deleting = new Promise<void>(done => { entered = done })
  const calls: string[] = []
  globalThis.fetch = async (_url, options) => {
    calls.push(options?.method || 'GET')
    if (options?.method === 'DELETE') { entered(); await new Promise<void>(done => { release = done }) }
    return new Response(JSON.stringify({ id: 'new', cancelled: true }), { headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const cancelled = speechApi.cancel('old', 'p')
    await deleting
    const next = speechApi.start('p')
    assert.equal((await next).id, 'new')
    release()
    await cancelled
    assert.deepEqual(calls, ['DELETE', 'POST'])
  } finally { globalThis.fetch = original; await window.happyDOM.close() }
})


test('legacy single-recording backend asks for a restart instead of reporting microphone contention', async () => {
  const { window } = installDomEnvironment()
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: '已有录音正在进行' }), {
    status: 409, headers: { 'Content-Type': 'application/json' },
  })
  try {
    await assert.rejects(speechApi.start('p'), { message: 'speech.backendUpdateRequired' })
  } finally { globalThis.fetch = original; await window.happyDOM.close() }
})

test('new backend capacity and permission failures retain their actual cause', async () => {
  const { window } = installDomEnvironment()
  const original = globalThis.fetch
  try {
    for (const [status, detail] of [[409, '语音并发已达上限（4 路），请稍后重试'], [403, '语音输入需要编辑权限']] as const) {
      globalThis.fetch = async () => new Response(JSON.stringify({ detail }), {
        status, headers: { 'Content-Type': 'application/json' },
      })
      await assert.rejects(speechApi.start('p'), { message: detail })
    }
  } finally { globalThis.fetch = original; await window.happyDOM.close() }
})
