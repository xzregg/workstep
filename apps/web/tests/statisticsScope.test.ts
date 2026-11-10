import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { statisticsApi } from '../src/api/statistics'
import { useGatewaySessionStore, type GatewayRemoteSession } from '../src/stores/gatewaySessionStore'

test('statistics waits for authenticated scope before sending its first request', async () => {
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch
  const previous = useGatewaySessionStore.getState()
  const browser = new Window({ url: 'https://gateway.example/workspace/device/statistics' })
  Object.assign(globalThis, { window: browser })
  const requests: string[] = []
  let resolve!: (session: GatewayRemoteSession) => void
  const session = new Promise<GatewayRemoteSession>(done => { resolve = done })
  useGatewaySessionStore.setState({ session: null, load: () => session })
  globalThis.fetch = async input => { requests.push(String(input)); return new Response('{}', { headers: { 'Content-Type': 'application/json' } }) }
  try {
    const pending = statisticsApi.overview({ range: '30d', timezone: 'Asia/Shanghai' })
    await new Promise(done => setTimeout(done, 0))
    assert.equal(requests.length, 0)
    resolve({ device_id: 'device', device_name: 'Device', username: 'self', gateway_url: 'https://gateway.example', project_id: 'published', host_project_id: 'shared', access_level: 'read', task_create: false, share_create: false, can_manage_project_access: false })
    await pending
    const url = new URL(requests[0], browser.location.origin)
    assert.equal(url.searchParams.get('project_id'), 'shared')
    assert.equal(url.searchParams.get('range'), '30d')
    assert.equal(url.searchParams.get('timezone'), 'Asia/Shanghai')
    await assert.rejects(statisticsApi.overview({ projectId: 'private' }), /项目范围不匹配/)
    assert.equal(requests.length, 1)
  } finally {
    globalThis.fetch = previousFetch
    Object.assign(globalThis, { window: previousWindow })
    useGatewaySessionStore.setState(previous)
    await browser.happyDOM.close()
  }
})
