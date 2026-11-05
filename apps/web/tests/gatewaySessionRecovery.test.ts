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

for (const projectId of [null, 'platform-project']) {
  test(`expired workspace recovers once using platform authorization and preserves scope ${projectId}`, async () => {
    const { window } = installDomEnvironment()
    window.happyDOM.setURL('https://gateway.test/workspace/one/chat?session=current#message')
    const oldFetch = globalThis.fetch
    let expired = false, redeemed = false
    const calls: string[] = []
    const session = { device_id: 'one', gateway_url: 'https://gateway.test/devices', project_id: projectId,
      host_project_id: projectId ? 'host-project' : null, access_level: projectId ? 'read' : null }
    globalThis.fetch = async (input, options) => {
      const path = String(input); calls.push(path)
      if (path === '/workspace/one/api/remote/session') return expired && !redeemed
        ? Response.json({}, { status: 401 }) : Response.json(session)
      if (path === `/api/${projectId ? 'projects/platform-project' : 'devices/one'}/access`) {
        assert.equal(options?.credentials, 'same-origin')
        return Response.json({ url: 'https://gateway.test/workspace/one/', ticket: 'fresh-ticket' })
      }
      if (path === 'https://gateway.test/workspace/one/api/remote/redeem') {
        assert.equal(options?.method, 'POST')
        assert.equal(options?.redirect, 'manual')
        assert.equal(new URLSearchParams(String(options?.body)).get('ticket'), 'fresh-ticket')
        redeemed = true
        const response = new Response(null, { status: projectId ? 200 : 303 })
        if (projectId) Object.defineProperty(response, 'type', { value: 'opaqueredirect' })
        return response
      }
      throw Error(`Unexpected ${path}`)
    }
    useGatewaySessionStore.setState({ session: null, error: '', errorStatus: null, loading: false })
    try {
      await useGatewaySessionStore.getState().load(true)
      // Android can reload the page after a long background stay; only tab storage survives.
      useGatewaySessionStore.setState({ session: null })
      expired = true; calls.length = 0
      const [first, second] = await Promise.all([useGatewaySessionStore.getState().load(true), useGatewaySessionStore.getState().load(true)])
      assert.equal(first.project_id, projectId)
      assert.equal(second.device_id, 'one')
      assert.equal(calls.filter(path => path.endsWith('/access')).length, 1)
      assert.equal(calls.filter(path => path.endsWith('/remote/session')).length, 2)
      assert.equal(window.location.pathname + window.location.search + window.location.hash, '/workspace/one/chat?session=current#message')
      assert.equal(useGatewaySessionStore.getState().errorStatus, null)
    } finally {
      globalThis.fetch = oldFetch
      useGatewaySessionStore.setState({ session: null, error: '', errorStatus: null, loading: false })
      await window.happyDOM.close()
    }
  })
}

for (const failure of ['platform-logout', 'redeem-denied', 'still-expired', 'external-url']) {
  test(`authorization recovery fails closed: ${failure}`, async () => {
    const { window } = installDomEnvironment()
    window.happyDOM.setURL('https://gateway.test/workspace/one/')
    const oldFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = async input => {
      const path = String(input); calls.push(path)
      if (path.endsWith('/remote/session')) return Response.json({}, { status: 401 })
      if (path === '/api/projects/project-only/access') return failure === 'platform-logout'
        ? Response.json({}, { status: 401 })
        : Response.json({ url: failure === 'external-url' ? 'https://other.test/workspace/one/' : 'https://gateway.test/workspace/one/', ticket: 'ticket' })
      assert.equal(path, 'https://gateway.test/workspace/one/api/remote/redeem')
      return new Response(null, { status: failure === 'redeem-denied' ? 403 : 303 })
    }
    useGatewaySessionStore.setState({ session: { device_id: 'one', project_id: 'project-only' } as any,
      error: '', errorStatus: null, loading: false })
    try {
      await assert.rejects(useGatewaySessionStore.getState().load(true))
      assert.equal(calls.filter(path => path.endsWith('/access')).length, 1)
      assert.equal(calls.filter(path => path.endsWith('/remote/session')).length, failure === 'still-expired' ? 2 : 1)
      assert.equal(calls.filter(path => path.endsWith('/redeem')).length, ['platform-logout', 'external-url'].includes(failure) ? 0 : 1)
      assert.equal(useGatewaySessionStore.getState().session, null)
    } finally {
      globalThis.fetch = oldFetch
      useGatewaySessionStore.setState({ session: null, error: '', errorStatus: null, loading: false })
      await window.happyDOM.close()
    }
  })
}

for (const status of [401, 403, 503]) {
  test(`workspace recovery stops on status ${status} without loops or scope fallback`, async () => {
    const { window } = installDomEnvironment()
    window.happyDOM.setURL('https://gateway.test/workspace/one/')
    const oldFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = async input => {
      const path = String(input); calls.push(path)
      if (path === '/workspace/one/api/remote/session') return Response.json({}, { status })
      assert.equal(path, '/api/projects/project-only/access')
      return Response.json({}, { status: 403 })
    }
    useGatewaySessionStore.setState({ session: { device_id: 'one', project_id: 'project-only' } as any,
      error: '', errorStatus: null, loading: false })
    try {
      await assert.rejects(useGatewaySessionStore.getState().load(true))
      assert.equal(calls.length, status === 401 ? 2 : 1)
      assert.equal(useGatewaySessionStore.getState().session?.device_id ?? null, status === 503 ? 'one' : null)
      assert.equal(useGatewaySessionStore.getState().errorStatus, status === 401 ? 403 : status)
      assert.equal(useGatewaySessionStore.getState().loading, false)
    } finally {
      globalThis.fetch = oldFetch
      useGatewaySessionStore.setState({ session: null, error: '', errorStatus: null, loading: false })
      await window.happyDOM.close()
    }
  })
}

for (const reason of [new TypeError('Network failed'), new DOMException('Timeout', 'AbortError')]) {
  test(`temporary session check failure preserves the last session: ${reason.name}`, async () => {
    const { window } = installDomEnvironment()
    const oldFetch = globalThis.fetch
    const session = { device_id: 'one', gateway_url: 'https://gateway.test/', project_id: null, host_project_id: null } as any
    useGatewaySessionStore.setState({ session, error: '', errorStatus: null, loading: false })
    globalThis.fetch = async () => { throw reason }
    try {
      await assert.rejects(useGatewaySessionStore.getState().load(true))
      assert.equal(useGatewaySessionStore.getState().session, session)
      assert.equal(useGatewaySessionStore.getState().loading, false)
    } finally {
      globalThis.fetch = oldFetch
      useGatewaySessionStore.setState({ session: null, error: '', errorStatus: null, loading: false })
      await window.happyDOM.close()
    }
  })
}

test('an invalid session response still removes the previous session', async () => {
  const { window } = installDomEnvironment()
  const oldFetch = globalThis.fetch
  useGatewaySessionStore.setState({ session: { device_id: 'one' } as any, error: '', errorStatus: null, loading: false })
  globalThis.fetch = async () => Response.json(null)
  try {
    await assert.rejects(useGatewaySessionStore.getState().load(true))
    assert.equal(useGatewaySessionStore.getState().session, null)
  } finally {
    globalThis.fetch = oldFetch
    useGatewaySessionStore.setState({ session: null, error: '', errorStatus: null, loading: false })
    await window.happyDOM.close()
  }
})
