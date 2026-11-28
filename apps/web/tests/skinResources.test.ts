import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomEnvironment } from './helpers/domEnv'
import { SkinResources } from '../src/skins/resources'

test('skin CSS and fonts load through fetch, deduplicate resources and release blob URLs', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('https://gateway.example.com/p2p/device/')
  const originalFetch = globalThis.fetch
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  const requests: string[] = []
  const revoked: string[] = []
  let sequence = 0
  globalThis.fetch = async input => {
    requests.push(String(input))
    return new Response('resource', { headers: { 'Content-Type': 'font/woff2' } })
  }
  URL.createObjectURL = () => `blob:skin-${++sequence}`
  URL.revokeObjectURL = value => { revoked.push(value) }
  const resources = new SkinResources()
  try {
    const url = '/api/skins/files/abc/assets/body.woff2?project_id=p1'
    const source = `@font-face{font-family:custom;src:url("${url}")} body{background:url("${url}")}`
    const css = await resources.css(source)
    assert.equal(requests.length, 1)
    assert.equal(requests[0], url)
    assert.equal(css.match(/blob:skin-1/g)?.length, 2)
    assert.equal(resources.get(url), 'blob:skin-1')
    await assert.rejects(resources.load('https://other.example.com/theme.js'), /Invalid skin/)
    resources.dispose()
    assert.deepEqual(revoked, ['blob:skin-1'])
  } finally {
    resources.dispose()
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
    await window.happyDOM.close()
  }
})
