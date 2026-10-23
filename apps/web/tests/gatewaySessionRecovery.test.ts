import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'

test('a stalled gateway session times out, releases deduplication, and can recover', async () => {
  const { window } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  const originalTimeout = window.setTimeout
  let expire: (() => void) | undefined
  window.setTimeout = ((callback: () => void, delay: number) => {
    if (delay === 10000) { expire = callback; return 1 }
    return originalTimeout(callback, delay)
  }) as typeof window.setTimeout
  let calls = 0
  globalThis.fetch = async (_input, options) => {
    calls++
    if (calls === 1) return new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Timeout', 'AbortError')))
    })
    return Response.json({device_id:'one',gateway_url:'https://gateway.test/',project_id:null,host_project_id:null})
  }
  try {
    const first = useGatewaySessionStore.getState().load(true)
    const second = useGatewaySessionStore.getState().load(true)
    assert.equal(first, second)
    await Promise.resolve()
    assert.ok(expire, 'session check needs a deadline')
    expire()
    await assert.rejects(first)
    assert.equal(useGatewaySessionStore.getState().loading, false)
    assert.equal((await useGatewaySessionStore.getState().load(true)).device_id, 'one')
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = originalFetch
    useGatewaySessionStore.setState({session:null,error:'',loading:false})
    await window.happyDOM.close()
  }
})
