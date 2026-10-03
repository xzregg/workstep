import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import GatewayPlatformSettings from '../src/pages/GatewayPlatformSettings'
import RemoteAccessSettings from '../src/pages/RemoteAccessSettings'
import { useManagedModeStore } from '../src/stores/managedModeStore'

test('remote access contains gateway authentication and switches legacy access only in ordinary mode', async () => {
 const { window } = installDomEnvironment()
 const original = globalThis.fetch
 const calls: string[] = []
 globalThis.fetch = async input => {
  const url=String(input); calls.push(url)
  if(url.includes('/gateway-platform/')) return Response.json({url:'http://localhost:8700', authenticated:false,online:false,package_locked:false})
  if(url.includes('/devices/list')) return Response.json({devices:[],connected_count:0})
  return Response.json({enabled:false,internal_base_url:'',external_base_url:'',host_id:'',access_password_set:false})
 }
 useManagedModeStore.setState({managed:false,loading:false})
 const container=document.body.appendChild(document.createElement('div')); const root=createRoot(container)
 try {
  await act(async()=>root.render(<I18nProvider><RemoteAccessSettings /></I18nProvider>))
  assert.equal(container.querySelector<HTMLInputElement>('input')?.value,'http://localhost:8700')
  const tabs=container.querySelectorAll<HTMLButtonElement>('.remote-access-tabs button')
  assert.equal(tabs.length,2)
  await act(async()=>tabs[1].click())
  assert.ok(calls.some(url=>url.includes('/remote-project/settings')))
  assert.equal(container.querySelector('.gateway-platform-settings'),null)
  await act(async()=>useManagedModeStore.setState({managed:true}))
  assert.equal(container.querySelectorAll('.remote-access-tabs button').length,1)
  assert.equal(container.querySelector<HTMLInputElement>('input')?.value,'http://localhost:8700')
 } finally {
  await act(async()=>root.unmount()); globalThis.fetch=original;useManagedModeStore.setState({managed:null,loading:false});container.remove();await window.happyDOM.close()
 }
})

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

test('gateway settings show a readable error for an older daemon and allow retry',async()=>{
 const {window}=installDomEnvironment();const original=globalThis.fetch
 let old=true
 globalThis.fetch=async()=>old ? new Response('<!doctype html><html></html>',{headers:{'Content-Type':'text/html'}}) : Response.json({url:'http://localhost:8700',authenticated:false,online:false,pending_device:false,package_locked:false})
 const container=document.body.appendChild(document.createElement('div'));const root=createRoot(container)
 try {
  await act(async()=>root.render(<I18nProvider><GatewayPlatformSettings /></I18nProvider>))
  assert.match(container.querySelector('[role=alert]')?.textContent??'',/无法读取平台设置/)
  assert.doesNotMatch(container.textContent??'',/doctype|Unexpected token/)
  old=false
  await act(async()=>container.querySelector<HTMLButtonElement>('[role=alert] button')!.click())
  assert.equal(container.querySelector<HTMLInputElement>('input')?.value,'http://localhost:8700')
 } finally {await act(async()=>root.unmount());globalThis.fetch=original;container.remove();await window.happyDOM.close()}
})
