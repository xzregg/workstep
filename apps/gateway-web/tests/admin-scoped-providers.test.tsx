import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { AdminScopedProviderAssignmentsPage } from '../src/AdminScopedProviderAssignmentsPage'
const dom = new JSDOM('<html><body></body></html>', { url: 'https://gateway.test/admin/device-groups' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')

test('scoped provider page loads safe catalog and reuses scoped assignments without global configuration', async () => {
  const oldFetch = globalThis.fetch
  const paths: string[] = []
  globalThis.fetch = async input => {
    const path = String(input); paths.push(path)
    if (path === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (path === '/api/admin/providers/assignment-catalog') return Response.json({ providers: [
      { id: 'p1', name: 'Company API', enabled: true }, { id: 'p2', name: 'Backup API', enabled: false },
    ] })
    if (path.startsWith('/api/admin/providers/p1/assignments?')) return Response.json({ assignments: [
      { id: 'a1', subject_type: 'user', subject_id: 'u1', subject_name: 'Department User', is_default: false },
    ], total: 1 })
    if (path.startsWith('/api/admin/providers/p2/assignments?')) return Response.json({ assignments: [], total: 0 })
    throw new Error(path)
  }
  try {
    render(<AdminScopedProviderAssignmentsPage />)
    await screen.findByText('Department User')
    assert.equal(screen.queryByLabelText('API Key'), null)
    fireEvent.change(screen.getByLabelText('供应商'), { target: { value: 'p2' } })
    await waitFor(() => assert.ok(paths.some(path => path.includes('/p2/assignments?'))))
    assert.equal(paths.includes('/api/admin/providers'), false)
  } finally { cleanup(); globalThis.fetch = oldFetch }
})
