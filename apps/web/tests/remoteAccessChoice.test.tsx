import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import RemoteAccessGate from '../src/components/RemoteAccessGate'
import { I18nProvider } from '../src/i18n'

for (const gateway of [false, true]) {
  test(`remote access offers Gateway login only when available=${gateway}`, async () => {
    const { window } = installDomEnvironment()
    const original = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = async input => {
      calls.push(String(input))
      return Response.json({ required: true, local: false, authorized: false, gateway_login_available: gateway })
    }
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    try {
      await act(async () => root.render(<I18nProvider><RemoteAccessGate><p>工作台</p></RemoteAccessGate></I18nProvider>))
      assert.ok(host.querySelector('input[type="password"]'))
      const login = host.querySelector<HTMLAnchorElement>('a[href="/gateway/login"]')
      assert.equal(Boolean(login), gateway)
      assert.equal(host.textContent?.includes('工作台'), false)
      assert.equal(calls.filter(url => url.endsWith('/access/status')).length, 1)
    } finally {
      await act(async () => root.unmount())
      globalThis.fetch = original
      await window.happyDOM.close()
    }
  })
}

test('native key can unlock the workspace without starting Gateway login', async () => {
  const { window } = installDomEnvironment()
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/access/unlock')) {
      assert.deepEqual(JSON.parse(String(init?.body)), { password: 'demo-key' })
      return Response.json({ authorized: true })
    }
    return Response.json({ required: true, local: false, authorized: false, gateway_login_available: true })
  }
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    await act(async () => root.render(<I18nProvider><RemoteAccessGate><p>工作台</p></RemoteAccessGate></I18nProvider>))
    const submit = host.querySelector<HTMLButtonElement>('.btn-primary')!
    assert.equal(submit.disabled, true)
    const input = host.querySelector<HTMLInputElement>('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'demo-key')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await act(async () => submit.click())
    assert.equal(host.textContent, '工作台')
    assert.equal(calls.filter(url => url.endsWith('/access/unlock')).length, 1)
    assert.equal(calls.some(url => url.includes('/gateway-platform/')), false)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = original
    await window.happyDOM.close()
  }
})
