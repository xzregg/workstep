import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import GatewayPlatformSettings from '../src/pages/GatewayPlatformSettings'

test('platform settings preserve configured address after login failure and submit once', async () => {
 const { window } = installDomEnvironment()
 const original = globalThis.fetch
 const calls: { url: string; body?: string }[] = []
 let finish: (value: Response) => void = () => {}
 globalThis.fetch = async (input, init) => {
  const url = String(input); calls.push({ url, body: String(init?.body ?? '') })
  if (url.endsWith('/settings')) return Response.json({ url: 'http://localhost:8700', authenticated: false, online: false, pending_device: true, package_locked: false })
  return new Promise(resolve => { finish = resolve })
 }
 const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
 try {
  await act(async () => root.render(<I18nProvider><GatewayPlatformSettings /></I18nProvider>))
  assert.match(container.textContent ?? '', /设备待管理员审批/)
  assert.equal(container.querySelector<HTMLInputElement>('input')?.value, 'http://localhost:8700')
  const form = container.querySelector('form')!
  await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })) })
  assert.equal(calls.filter(c => c.url.endsWith('/login')).length, 1)
  assert.deepEqual(JSON.parse(calls[1].body!), { url: 'http://localhost:8700' })
  await act(async () => finish(new Response(null, { status: 502 })))
  assert.match(container.textContent ?? '', /无法连接平台/)
  assert.equal(container.querySelector<HTMLInputElement>('input')?.value, 'http://localhost:8700')
  assert.equal(container.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled, false)
 } finally {
  await act(async () => root.unmount()); globalThis.fetch = original; container.remove(); await window.happyDOM.close()
 }
})


test('returning from platform authentication refreshes desktop settings and unlocks retry', async () => {
 const { window } = installDomEnvironment()
 const original = globalThis.fetch
 let settingsCalls = 0
 globalThis.fetch = async input => {
  if (String(input).endsWith('/settings')) {
   settingsCalls++
   return Response.json({ url:'http://localhost:8700',authenticated:false,online:false,pending_device:settingsCalls>1,package_locked:false })
  }
  return Response.json({ authorization_url:'http://localhost:8700/desktop/login?state=test' })
 }
 const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
 try {
  await act(async () => root.render(<I18nProvider><GatewayPlatformSettings /></I18nProvider>))
  await act(async () => container.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})))
  assert.equal(container.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled,true)
  await act(async () => window.dispatchEvent(new window.Event('focus')))
  assert.equal(settingsCalls,2)
  assert.match(container.textContent ?? '',/设备待管理员审批/)
  assert.equal(container.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled,false)
 } finally { await act(async () => root.unmount());globalThis.fetch=original;container.remove();await window.happyDOM.close() }
})
