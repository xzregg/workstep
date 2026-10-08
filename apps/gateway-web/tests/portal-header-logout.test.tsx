import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { PortalHeader } from '../src/PortalHeader'
const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { render, screen, fireEvent, cleanup } = await import('@testing-library/react')
test('logout keeps failures retryable and clears the server session before navigation', async () => {
 const previous = globalThis.fetch
 let attempts = 0, changes = 0
 const listener = () => changes++
 window.addEventListener('gateway-auth-changed', listener)
 globalThis.fetch = async (input, init) => {
  if (String(input) === '/api/auth/session') return Response.json({ csrf_token: 'csrf-test' })
  assert.equal(String(input), '/api/auth/logout')
  assert.equal(init?.method, 'POST')
  assert.equal(new Headers(init?.headers).get('X-CSRF-Token'), 'csrf-test')
  attempts++
  return new Response(null, { status: attempts === 1 ? 503 : 204 })
 }
 try {
  render(<MemoryRouter><Routes><Route path="/" element={<PortalHeader signedIn hasAdminAccess={false} />} /><Route path="/auth" element={<p>登录页面</p>} /></Routes></MemoryRouter>)
  fireEvent.click(screen.getByRole('button', { name: '登出' }))
  await screen.findByRole('alert')
  assert.equal(changes, 0)
  fireEvent.click(screen.getByRole('button', { name: '登出' }))
  await screen.findByText('登录页面')
  assert.equal(changes, 1)
 } finally { cleanup(); globalThis.fetch = previous; window.removeEventListener('gateway-auth-changed', listener) }
})
