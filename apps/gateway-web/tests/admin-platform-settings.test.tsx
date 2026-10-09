import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AdminPlatformSettingsPage } from '../src/AdminPlatformSettingsPage'
import { AdminRegistrationPolicyDialog } from '../src/AdminRegistrationPolicyDialog'
import { AdminPlatformAddressDialog } from '../src/AdminPlatformAddressDialog'
import { AdminLoginPolicyDialog } from '../src/AdminLoginPolicyDialog'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://gateway.test/admin/settings',
})
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('login policy protects edits, verifies password, and preserves a rejected change for retry',async()=>{
 let writes=0;let saved=0
 globalThis.fetch=async(input,init)=>{
  if(String(input)==='/api/auth/step-up')return Response.json({})
  assert.equal(String(input),'/api/admin/login-policy')
  assert.deepEqual(JSON.parse(String(init?.body)),{password_login_enabled:false})
  writes++;return writes===1?new Response(null,{status:409}):Response.json({password_login_enabled:false})
 }
 render(<AdminLoginPolicyDialog enabled csrf="csrf" onClose={()=>{}} onSaved={()=>saved++}/>)
 fireEvent.click(screen.getByRole('checkbox',{name:'启用账号密码登录'}))
 fireEvent.click(screen.getByRole('button',{name:'取消'}))
 const discard=screen.getByRole('dialog',{name:'放弃登录方式修改'})
 fireEvent.click(within(discard).getByRole('button',{name:'取消'}))
 fireEvent.change(screen.getByLabelText('管理员密码'),{target:{value:'secret'}})
 fireEvent.click(screen.getByRole('button',{name:'保存登录方式'}))
 await screen.findByRole('alert')
 assert.equal((screen.getByRole('checkbox') as HTMLInputElement).checked,false)
 assert.equal(saved,0)
 fireEvent.click(screen.getByRole('button',{name:'保存登录方式'}))
 await waitFor(()=>assert.equal(saved,1));assert.equal(writes,2)
})

test('platform settings retries loading and updates registration after step-up', async () => {
  const calls: Array<{ url: string; method: string }> = []
  let reads = 0
  let mode = 'open'
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET' })
    if (url === '/api/admin/platform-settings') {
      if (reads++ === 0) return new Response(null, { status: 503 })
      return Response.json({ gateway_id: 'gateway-test', public_origin: 'https://gateway.test',
        registration_mode: mode, session_seconds: 86400, protocol_version: 3,
        data_dir: '/srv/workstep', database: { backend: 'postgresql', location: 'db.internal/app',
          healthy: true, migration_version: '0028_group_project_capabilities' } })
    }
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url === '/api/auth/step-up') return Response.json({ expires_in_seconds: 300 })
    if (url === '/api/admin/registration-policy') {
      mode = JSON.parse(String(init?.body)).mode
      return Response.json({ mode })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter><AdminPlatformSettingsPage /></MemoryRouter>)
  await screen.findByText(/平台设置加载失败/)
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByText('gateway-test')
  assert.match(document.body.textContent ?? '', /db.internal\/app/)
  fireEvent.click(screen.getByRole('button', { name: '修改注册策略' }))
  fireEvent.change(screen.getByLabelText('注册策略'), { target: { value: 'open_with_approval' } })
  fireEvent.change(screen.getByLabelText('管理员密码'), { target: { value: 'secret-password' } })
  fireEvent.click(screen.getByRole('button', { name: '保存策略' }))
  await screen.findByText(/当前策略：开放注册，管理员审核/)
  assert.equal(screen.queryByRole('dialog'), null)
  assert.ok(calls.some(call => call.url === '/api/auth/step-up' && call.method === 'POST'))
  assert.ok(calls.some(call => call.url === '/api/admin/registration-policy' && call.method === 'PUT'))
})

test('registration dialog protects an edited policy and retains failed submission', async () => {
  let closed = false
  let saved = false
  globalThis.fetch = async input => {
    if (String(input) === '/api/auth/step-up') return new Response(null, { status: 403 })
    throw new Error(`Unexpected fetch: ${input}`)
  }
  render(<AdminRegistrationPolicyDialog mode="open" csrf="csrf"
    onClose={() => { closed = true }} onSaved={() => { saved = true }} />)
  fireEvent.change(screen.getByLabelText('注册策略'), { target: { value: 'closed' } })
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  assert.equal(closed, false)
  assert.ok(screen.getByRole('dialog', { name: '放弃修改' }))
  fireEvent.click(screen.getByRole('dialog', { name: '放弃修改' }).querySelector('button')!)
  assert.equal(closed, false)
  fireEvent.change(screen.getByLabelText('管理员密码'), { target: { value: 'wrong' } })
  fireEvent.click(screen.getByRole('button', { name: '保存策略' }))
  await screen.findByText('密码验证失败。')
  assert.equal(saved, false)
  assert.equal(closed, false)
})


test('platform address copies the configured URL and explains deployment configuration', async () => {
  let copied = ''
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied = value } } })
  globalThis.fetch = async input => String(input) === '/api/admin/platform-settings'
    ? Response.json({ gateway_id: 'test', public_origin: 'http://localhost:8700', registration_mode: 'open', session_seconds: 86400, protocol_version: 3, data_dir: '/data', database: { backend: 'sqlite', location: '/data/db', healthy: true, migration_version: null } })
    : Response.json({ csrf_token: 'csrf', sources: [] })
  render(<MemoryRouter><AdminPlatformSettingsPage /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '复制地址' }))
  await screen.findByText('地址已复制')
  assert.equal(copied, 'http://localhost:8700')
  assert.ok(screen.getByRole('button', { name: '修改平台地址' }))
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied') } } })
  fireEvent.click(screen.getByRole('button', { name: '复制地址' }))
  await screen.findByText('复制失败，请选中地址手动复制。')
})


test('administrator saves a domain with step-up and retains failed edits', async () => {
  let origin = 'http://localhost:8700'; let writes = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/admin/platform-settings') return Response.json({ gateway_id: 'test', public_origin: origin, registration_mode: 'open', session_seconds: 86400, protocol_version: 3, data_dir: '/data', database: { backend: 'sqlite', location: 'db', healthy: true, migration_version: null } })
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url === '/api/auth/step-up') return Response.json({})
    if (url === '/api/admin/platform-address') {
      assert.equal(init?.method, 'PUT')
      assert.equal(new Headers(init?.headers).get('X-CSRF-Token'), 'csrf')
      writes++
      if (writes === 1) return new Response(null, { status: 503 })
      origin = JSON.parse(String(init?.body)).public_origin
      return Response.json({ public_origin: origin })
    }
    return Response.json({ sources: [] })
  }
  let saved = false
  render(<AdminPlatformAddressDialog address={origin} csrf="csrf" onClose={()=>{}} onSaved={()=>{saved=true}}/>)
  fireEvent.change(screen.getByLabelText('平台地址'), { target: { value: 'https://workstep.example.com/' } })
  fireEvent.change(screen.getByLabelText('管理员密码'), { target: { value: 'password' } })
  fireEvent.click(screen.getByRole('button', { name: '保存平台地址' }))
  await screen.findByRole('alert')
  assert.equal((screen.getByLabelText('平台地址') as HTMLInputElement).value, 'https://workstep.example.com/')
  fireEvent.click(screen.getByRole('button', { name: '保存平台地址' }))
  await waitFor(()=>assert.equal(saved, true))
  assert.equal(origin, 'https://workstep.example.com')
  assert.equal(writes, 2)
})
