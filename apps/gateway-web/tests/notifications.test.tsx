import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { PortalHeader } from '../src/PortalHeader'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://gateway.test/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver, Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { render, screen, cleanup } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
const originalSocket = globalThis.WebSocket
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket; delete (window as any).WorkStepAndroid })

for (const android of [false, true]) {
  test(`portal has no notification badge, history request or aggregate socket (Android=${android})`, async () => {
    const requests: string[] = [], sockets: string[] = []
    globalThis.fetch = async input => { requests.push(String(input)); return Response.json({ events: [], unread: 999, cursor: 999, more: true }) }
    class Socket {
      constructor(url: string) { sockets.push(url) }
      close() {}
      send() {}
    }
    globalThis.WebSocket = Socket as unknown as typeof WebSocket
    if (android) Object.assign(window, { WorkStepAndroid: { postMessage: () => {} } })
    render(<MemoryRouter><PortalHeader signedIn hasAdminAccess={false}/></MemoryRouter>)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.ok(screen.getByRole('navigation', { name: '工作台导航' }))
    assert.ok(screen.getByRole('button', { name: '登出' }))
    assert.equal(screen.queryByRole('button', { name: /通知/ }), null)
    assert.equal(document.querySelector('.gateway-notifications'), null)
    assert.deepEqual(requests, [])
    assert.deepEqual(sockets, [])
  })
}
