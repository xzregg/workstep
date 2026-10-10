import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomEnvironment } from './helpers/domEnv'
import { restoreLocalGatewayMode } from '../src/utils/gatewayLocalFallback'

for (const address of ['http://localhost:5173', 'http://192.168.52.156:8765', 'https://workstep.base.packertec.com']) {
test(`cancellation disables Gateway before app starts at ${address}`, async () => {
  const { window } = installDomEnvironment()
  window.location.href = address + '/?gateway_auth=cancelled&project=demo'
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${input}`)
    if (init?.method === 'PUT') {
      assert.deepEqual(JSON.parse(String(init.body)), { url: 'http://localhost:8700', enabled: false })
      assert.equal(new Headers(init.headers).get('Origin'), address)
    }
    return Response.json({ url: 'http://localhost:8700', enabled: true, package_locked: false })
  }
  try {
    await restoreLocalGatewayMode()
    assert.deepEqual(calls, ['GET /api/gateway-platform/settings', 'PUT /api/gateway-platform/settings'])
    assert.equal(window.location.search, '?project=demo')
    await restoreLocalGatewayMode()
    assert.equal(calls.length, 2)
  } finally { globalThis.fetch = original; await window.happyDOM.close() }
})

}

test('failed fallback keeps marker and prevents app startup', async () => {
  const { window } = installDomEnvironment()
  window.location.href = 'http://localhost:5173/?gateway_auth=cancelled'
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 503 })
  try {
    await assert.rejects(restoreLocalGatewayMode())
    assert.equal(window.location.search, '?gateway_auth=cancelled')
  } finally { globalThis.fetch = original; await window.happyDOM.close() }
})

for (const address of ['http://localhost:5173/', 'https://d-device.gateway.example/?gateway_auth=cancelled', 'http://localhost:5173/workspace/device/?gateway_auth=cancelled']) {
  test(`ordinary and remote pages do not change Gateway settings: ${address}`, async () => {
    const { window } = installDomEnvironment()
    window.location.href = address
    const original = globalThis.fetch
    globalThis.fetch = async () => { assert.fail('unexpected fallback request') }
    try { await restoreLocalGatewayMode() }
    finally { globalThis.fetch = original; await window.happyDOM.close() }
  })
}
