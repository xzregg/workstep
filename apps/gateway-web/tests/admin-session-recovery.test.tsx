import { AdminProjectsPage } from '../src/AdminProjectsPage'
import { AdminSharesPage } from '../src/AdminSharesPage'
import { AdminProvidersPage } from '../src/AdminProvidersPage'
import { AdminGroupsPage } from '../src/AdminGroupsPage'
import { AdminSkillsPage } from '../src/AdminSkillsPage'
import { AdminDeviceOperationsPage } from '../src/AdminDeviceOperationsPage'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://gateway.test/admin/users' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event,
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})


for (const [name, Page] of [
  ['projects', AdminProjectsPage], ['shares', AdminSharesPage],
  ['providers', AdminProvidersPage], ['groups', AdminGroupsPage],
  ['skills', AdminSkillsPage], ['operations', AdminDeviceOperationsPage],
] as const) {
 test(`${name} retries the failed session request`, async () => {
  let sessions = 0
  globalThis.fetch = async input => {
   if (String(input) === '/api/auth/session') {
    if (++sessions === 1) throw new Error('offline')
    return Response.json({ csrf_token: 'csrf' })
   }
   return Response.json({ total: 0, projects: [], shares: [], providers: [], groups: [], skills: [], devices: [], operations: [] })
  }
  render(<MemoryRouter><Page /></MemoryRouter>)
  await screen.findByText('登录状态加载失败，请重试。')
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await waitFor(() => assert.equal(sessions, 2))
  await waitFor(() => assert.equal(screen.queryByText('登录状态加载失败，请重试。'), null))
 })
}
