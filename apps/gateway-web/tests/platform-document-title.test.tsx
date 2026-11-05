import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { PlatformDocumentTitle } from '../src/PlatformDocumentTitle'
import { loadPlatformStatus, publishCompanyName } from '../src/platformBranding'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://gateway.test/desktop/login' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, render, waitFor } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; document.title = 'WORKSTEP 平台' })


for (const name of ['示例科技', '']) test(`browser title includes company: ${name || 'unset'}`, async () => {
 globalThis.fetch = async input => {
  assert.equal(String(input), '/api/platform/status')
  return Response.json({ initialized: true, company_display_name: name })
 }
 render(<PlatformDocumentTitle />)
 await loadPlatformStatus()
 await waitFor(() => assert.equal(document.title, name ? `${name} · WORKSTEP 平台` : 'WORKSTEP 平台'))
})

test('saving and clearing the company immediately updates title and supersedes pending load', async () => {
 let finish!: (response: Response) => void
 globalThis.fetch = async () => new Promise(resolve => { finish = resolve })
 render(<PlatformDocumentTitle />)
 publishCompanyName('新公司')
 assert.equal(document.title, '新公司 · WORKSTEP 平台')
 finish(Response.json({ initialized: true, company_display_name: '旧公司' }))
 await new Promise(resolve => setTimeout(resolve, 0))
 assert.equal(document.title, '新公司 · WORKSTEP 平台')
 publishCompanyName('')
 assert.equal(document.title, 'WORKSTEP 平台')
})

test('branding load failure keeps the default browser title', async () => {
 globalThis.fetch = async () => new Response(null, { status: 503 })
 render(<PlatformDocumentTitle />)
 await new Promise(resolve => setTimeout(resolve, 0))
 assert.equal(document.title, 'WORKSTEP 平台')
})


test('title and login share concurrent status requests', async () => {
 let requests = 0
 globalThis.fetch = async () => {
  requests++
  return Response.json({ initialized: true, company_display_name: '示例公司' })
 }
 render(<PlatformDocumentTitle />)
 const status = await loadPlatformStatus()
 assert.equal(status.company_display_name, '示例公司')
 await waitFor(() => assert.equal(document.title, '示例公司 · WORKSTEP 平台'))
 assert.equal(requests, 1)
})
