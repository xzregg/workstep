import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { PortalAuthPage } from '../src/PortalAuthPage'
import { RegistrationPendingPage } from '../src/RegistrationPendingPage'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://gateway.test/auth' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

function mockPortal(mode = 'open', register: (init?: RequestInit) => Promise<Response> = async () => Response.json({}, { status: 201 })) {
  const calls: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push(url)
    if (url === '/api/platform/status') return Response.json({ initialized: true })
    if (url === '/api/auth/session') return new Response(null, { status: 401 })
    if (url === '/api/auth/registration-policy') return Response.json({ mode })
    if (url === '/api/auth/identity-sources') return Response.json({ sources: [] })
    if (url === '/api/auth/register') return register(init)
    throw new Error(`Unexpected request: ${url}`)
  }
  return calls
}

function mount() {
  return render(<MemoryRouter initialEntries={['/auth?next=%2Fdevices']}><Routes>
    <Route path="/auth" element={<PortalAuthPage />} />
    <Route path="/devices" element={<p>已进入我的电脑</p>} />
    <Route path="/auth/pending" element={<RegistrationPendingPage />} />
  </Routes></MemoryRouter>)
}

async function openRegistration() {
  fireEvent.click(await screen.findByRole('button', { name: '注册账号' }))
  await screen.findByRole('button', { name: '注册' })
}

function fill(username = 'alice') {
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: username } })
  fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Alice' } })
  fireEvent.change(screen.getByLabelText('密码（至少 12 位）'), { target: { value: 'AlicePassphrase-2026!' } })
  fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'AlicePassphrase-2026!' } })
}

test('open registration validates input, sends one request, and returns to the original target', async () => {
  let submitted: object | undefined
  const calls = mockPortal('open', async init => {
    submitted = JSON.parse(String(init?.body))
    return Response.json({}, { status: 201 })
  })
  mount(); await openRegistration()
  const button = screen.getByRole('button', { name: '注册' }) as HTMLButtonElement
  assert.equal(button.disabled, true)
  fill('A lice'); assert.equal(button.disabled, true)
  fill();
  fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'mismatch' } })
  assert.equal(button.disabled, true)
  fireEvent.submit(button.closest('form')!)
  assert.equal(calls.filter(url => url === '/api/auth/register').length, 0)
  fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'AlicePassphrase-2026!' } })
  fireEvent.click(button)
  await screen.findByText('已进入我的电脑')
  assert.deepEqual(submitted, { username: 'alice', display_name: 'Alice', password: 'AlicePassphrase-2026!' })
  assert.equal(calls.filter(url => url === '/api/auth/register').length, 1)
})

test('approval registration explains the pending state and does not enter the workbench', async () => {
  mockPortal('open_with_approval', async () => Response.json({}, { status: 202 }))
  mount(); await openRegistration(); fill()
  assert.ok(screen.getByText('提交后需等待管理员审核。'))
  fireEvent.click(screen.getByRole('button', { name: '注册' }))
  await screen.findByText('账号等待审核')
  assert.equal(screen.queryByText('已进入我的电脑'), null)
  assert.equal(screen.getByRole('link', { name: '返回登录' }).getAttribute('href'), '/auth?next=%2Fdevices')
})

test('closed registration exposes only the login entry', async () => {
  mockPortal('closed'); mount()
  await screen.findByRole('button', { name: '登录' })
  assert.equal(screen.queryByRole('button', { name: '注册账号' }), null)
})

test('duplicate username has an actionable error and preserves input for retry', async () => {
  let requests = 0
  mockPortal('open', async () => ++requests === 1
    ? Response.json({ detail: 'Username unavailable' }, { status: 409 })
    : Response.json({}, { status: 201 }))
  mount(); await openRegistration(); fill()
  fireEvent.click(screen.getByRole('button', { name: '注册' }))
  assert.match((await screen.findByRole('alert')).textContent ?? '', /用户名已被使用/)
  assert.equal((screen.getByLabelText('显示名称') as HTMLInputElement).value, 'Alice')
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice_two' } })
  fireEvent.click(screen.getByRole('button', { name: '注册' }))
  await screen.findByText('已进入我的电脑')
  assert.equal(requests, 2)
})

test('in-flight registration locks the form and rejects duplicate submit events', async () => {
  let finish!: (response: Response) => void
  const calls = mockPortal('open', () => new Promise(resolve => { finish = resolve }))
  mount(); await openRegistration(); fill()
  const form = screen.getByRole('button', { name: '注册' }).closest('form')!
  fireEvent.submit(form); fireEvent.submit(form)
  await screen.findByRole('button', { name: '正在提交…' })
  assert.equal((screen.getByLabelText('用户名') as HTMLInputElement).disabled, true)
  assert.equal((screen.getByRole('button', { name: '返回登录' }) as HTMLButtonElement).disabled, true)
  assert.ok(form.querySelector('.gateway-spinner'))
  assert.equal(calls.filter(url => url === '/api/auth/register').length, 1)
  finish(Response.json({}, { status: 201 }))
  await screen.findByText('已进入我的电脑')
})

test('registration remains available when the optional corporate identity request fails', async () => {
  mockPortal()
  const portalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/auth/identity-sources') throw new TypeError('Failed to fetch')
    return portalFetch(input, init)
  }
  mount(); await openRegistration(); fill()
  fireEvent.click(screen.getByRole('button', { name: '注册' }))
  await screen.findByText('已进入我的电脑')
})

test('registration closed after the form opened informs the user and returns to login', async () => {
  mockPortal('open', async () => Response.json({ detail: 'Registration is closed' }, { status: 403 }))
  mount(); await openRegistration(); fill()
  fireEvent.click(screen.getByRole('button', { name: '注册' }))
  assert.match((await screen.findByRole('alert')).textContent ?? '', /已关闭注册/)
  fireEvent.click(screen.getByRole('button', { name: '返回登录' }))
  await screen.findByRole('button', { name: '登录' })
  assert.equal(screen.queryByRole('button', { name: '注册账号' }), null)
})

test('network errors and rate limits allow retry without clearing the account', async () => {
  let requests = 0
  mockPortal('open', async () => {
    requests++
    if (requests === 1) throw new TypeError('private network error')
    if (requests === 2) return new Response(null, { status: 429 })
    return Response.json({}, { status: 201 })
  })
  mount(); await openRegistration(); fill()
  fireEvent.click(screen.getByRole('button', { name: '注册' }))
  assert.match((await screen.findByRole('alert')).textContent ?? '', /网络/)
  fireEvent.click(screen.getByRole('button', { name: '注册' }))
  await waitFor(() => assert.match(screen.getByRole('alert').textContent ?? '', /次数过多/))
  assert.equal((screen.getByLabelText('用户名') as HTMLInputElement).value, 'alice')
  fireEvent.click(screen.getByRole('button', { name: '注册' }))
  await screen.findByText('已进入我的电脑')
})


test('empty platform shows administrator setup using normal registration', async () => {
 let submitted: object | undefined
 globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url === '/api/platform/status') return Response.json({ initialized: false })
  if (url === '/api/auth/register') { submitted = JSON.parse(String(init?.body)); return Response.json({}, { status: 201 }) }
  throw new Error(`Unexpected request: ${url}`)
 }
 render(<MemoryRouter initialEntries={['/auth']}><Routes><Route path="/auth" element={<PortalAuthPage />} /><Route path="/admin" element={<p>进入管理后台</p>} /></Routes></MemoryRouter>)
 await screen.findByRole('heading', { name: '设置超级管理员' })
 assert.equal(screen.queryByLabelText('恢复账号用户名'), null)
 fill(); fireEvent.click(screen.getByRole('button', { name: '注册' }))
 await screen.findByText('进入管理后台')
 assert.equal((submitted as { username: string }).username, 'alice')
})
